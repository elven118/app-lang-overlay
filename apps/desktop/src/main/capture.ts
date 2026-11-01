import { createHash } from 'node:crypto';
import { type Display, type NativeImage } from 'electron';
import type { CaptureRegion, DesktopRect, WindowChoice } from '../shared/types';
import type { CapturedFrame } from './backend-client';
import { MAX_IMAGE_BYTES } from './protocol';
import { ScreenStream, captureWorkerPage } from './screen-stream';
import { readWindowBounds } from './window-bounds';
import { MacDisplayCapture } from './mac-display-capture';

export type CaptureTarget = {
  regionId: string;
  display: Display;
  region?: CaptureRegion;
  windowSource?: WindowChoice;
};

const MAX_LONG_EDGE = 3200;

function captureCoordinateScale(display: Display): number {
  return process.platform === 'win32' ? (display.scaleFactor || 1) : 1;
}

function cropForTarget(image: NativeImage, target: CaptureTarget): NativeImage {
  if (!target.region) return image;
  const imageSize = image.getSize();
  const bounds = target.display.bounds;
  const coordinateScale = captureCoordinateScale(target.display);
  const imageScaleX = imageSize.width / Math.max(1, bounds.width);
  const imageScaleY = imageSize.height / Math.max(1, bounds.height);
  const logicalLeft = target.region.left / coordinateScale - bounds.x;
  const logicalTop = target.region.top / coordinateScale - bounds.y;
  const logicalWidth = target.region.width / coordinateScale;
  const logicalHeight = target.region.height / coordinateScale;
  const x = Math.max(0, Math.min(imageSize.width - 1, Math.round(logicalLeft * imageScaleX)));
  const y = Math.max(0, Math.min(imageSize.height - 1, Math.round(logicalTop * imageScaleY)));
  const width = Math.max(1, Math.min(imageSize.width - x, Math.round(logicalWidth * imageScaleX)));
  const height = Math.max(1, Math.min(imageSize.height - y, Math.round(logicalHeight * imageScaleY)));
  return image.crop({ x, y, width, height });
}

function limitDimensions(image: NativeImage, maximumLongEdge = MAX_LONG_EDGE): NativeImage {
  const { width, height } = image.getSize();
  const longEdge = Math.max(width, height);
  if (longEdge <= maximumLongEdge) return image;
  const scale = maximumLongEdge / longEdge;
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best',
  });
}

function encodeWithinLimit(image: NativeImage): { image: NativeImage; jpeg: Buffer } {
  let normalized = limitDimensions(image);
  for (const quality of [80, 70, 55]) {
    const jpeg = normalized.toJPEG(quality);
    if (jpeg.length <= MAX_IMAGE_BYTES) return { image: normalized, jpeg };
  }
  normalized = limitDimensions(normalized, 2000);
  const jpeg = normalized.toJPEG(55);
  if (jpeg.length > MAX_IMAGE_BYTES) {
    throw new Error('Captured JPEG is larger than the 4 MiB protocol limit');
  }
  return { image: normalized, jpeg };
}

export class DesktopCapture {
  private generation = 0;
  private hashes = new Map<string, { value: string; repeats: number }>();
  private streams = new Map<string, Pick<ScreenStream, 'capture' | 'dispose'>>();

  constructor(private readonly workerPage = captureWorkerPage(),
    private readonly onBounds?: (regionId: string, bounds: DesktopRect) => void,
    private readonly excludedWindowIds: () => string[] = () => []) {}

  private async captureSource(target: CaptureTarget): Promise<NativeImage | null> {
    const key = target.windowSource?.id || `display-${target.display.id}`;
    let stream = this.streams.get(key);
    if (!stream) {
      stream = process.platform === 'darwin' && !target.windowSource
        ? new MacDisplayCapture(target.display, this.excludedWindowIds)
        : new ScreenStream(target.display, this.workerPage, target.windowSource?.id);
      this.streams.set(key, stream);
    }
    try {
      return await stream.capture();
    } catch (error) {
      stream.dispose();
      if (this.streams.get(key) === stream) this.streams.delete(key);
      throw error;
    }
  }

  async capture(targets: CaptureTarget[]): Promise<CapturedFrame[]> {
    const generation = this.generation;
    const results: CapturedFrame[] = [];
    const bySource = new Map<string, CaptureTarget[]>();
    for (const target of targets) {
      const key = target.windowSource?.id || `display-${target.display.id}`;
      const existing = bySource.get(key) ?? [];
      existing.push(target);
      bySource.set(key, existing);
    }
    for (const [key, stream] of this.streams) {
      if (!bySource.has(key)) {
        stream.dispose();
        this.streams.delete(key);
      }
    }

    for (const sourceTargets of bySource.values()) {
      const display = sourceTargets[0].display;
      const image = await this.captureSource(sourceTargets[0]);
      if (generation !== this.generation) return [];
      if (!image) continue;
      const windowBounds = sourceTargets[0].windowSource
        ? await readWindowBounds(sourceTargets[0].windowSource.id) : undefined;
      if (generation !== this.generation) return [];

      for (const target of sourceTargets) {
        const cropped = cropForTarget(image, target);
        const screenBoundsDip = target.windowSource ? windowBounds : target.region ? {
          x: Math.max(display.bounds.x, target.region.left / captureCoordinateScale(display)),
          y: Math.max(display.bounds.y, target.region.top / captureCoordinateScale(display)),
          width: cropped.getSize().width / image.getSize().width * display.bounds.width,
          height: cropped.getSize().height / image.getSize().height * display.bounds.height,
        } : { ...display.bounds };
        if (screenBoundsDip) this.onBounds?.(target.regionId, screenBoundsDip);
        const encoded = encodeWithinLimit(cropped);
        const hash = createHash('sha256').update(encoded.jpeg).digest('hex');
        const previous = this.hashes.get(target.regionId);
        const repeats = previous?.value === hash ? previous.repeats + 1 : 1;
        this.hashes.set(target.regionId, { value: hash, repeats });

        // A repeated second sample is intentional: the backend requires two
        // stable empty OCR samples before it clears the current translation.
        if (repeats > 2 && repeats % 10 !== 0) continue;

        const size = encoded.image.getSize();
        results.push({
          regionId: target.regionId,
          width: size.width,
          height: size.height,
          jpeg: encoded.jpeg,
          geometry: target.windowSource ? {
            sourceKind: 'window', windowId: target.windowSource.id, windowName: target.windowSource.name,
            imageWidth: size.width, imageHeight: size.height,
            screenBoundsDip,
          } : {
            sourceKind: 'display',
            displayId: display.id,
            displayBoundsDip: { ...display.bounds },
            displayScaleFactor: display.scaleFactor,
            imageWidth: size.width,
            imageHeight: size.height,
            screenBoundsDip,
          },
        });
      }
    }
    return results;
  }

  reset(): void {
    this.hashes.clear();
  }

  stop(): void {
    this.generation += 1;
    for (const stream of this.streams.values()) stream.dispose();
    this.streams.clear();
    this.reset();
  }
}
