import { createHash } from 'node:crypto';
import { desktopCapturer, systemPreferences, type DesktopCapturerSource, type Display, type NativeImage } from 'electron';
import type { CaptureRegion } from '../shared/types';
import type { CapturedFrame } from './backend-client';
import { MAX_IMAGE_BYTES } from './protocol';

export type CaptureTarget = {
  regionId: string;
  display: Display;
  region?: CaptureRegion;
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
  private hashes = new Map<string, { value: string; repeats: number }>();
  private emptyCaptureCounts = new Map<number, number>();

  private sourceForDisplay(sources: DesktopCapturerSource[], display: Display): DesktopCapturerSource | undefined {
    return sources.find((candidate) => candidate.display_id === String(display.id))
      ?? sources.find((candidate) => Boolean(display.label) && candidate.name.includes(display.label))
      ?? (sources.length === 1 ? sources[0] : undefined);
  }

  private screenPermissionStatus(): string {
    return process.platform === 'darwin'
      ? systemPreferences.getMediaAccessStatus('screen')
      : 'granted';
  }

  async capture(targets: CaptureTarget[]): Promise<CapturedFrame[]> {
    const results: CapturedFrame[] = [];
    const byDisplay = new Map<number, CaptureTarget[]>();
    for (const target of targets) {
      const existing = byDisplay.get(target.display.id) ?? [];
      existing.push(target);
      byDisplay.set(target.display.id, existing);
    }

    for (const displayTargets of byDisplay.values()) {
      const display = displayTargets[0].display;
      const scale = captureCoordinateScale(display);
      const thumbnailSize = {
        width: Math.max(1, Math.round(display.bounds.width * scale)),
        height: Math.max(1, Math.round(display.bounds.height * scale)),
      };
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize,
        fetchWindowIcons: false,
      });
      const source = this.sourceForDisplay(sources, display);
      if (!source) {
        const available = sources.map((candidate) => candidate.display_id || candidate.name).join(', ') || 'none';
        throw new Error(`Display ${display.id} is unavailable; re-select the capture region (available: ${available})`);
      }
      if (source.thumbnail.isEmpty()) {
        const permission = this.screenPermissionStatus();
        if (permission !== 'granted') {
          throw new Error(`Screen Recording permission is ${permission}; enable it in macOS System Settings and restart Electron`);
        }
        const emptyCount = (this.emptyCaptureCounts.get(display.id) ?? 0) + 1;
        this.emptyCaptureCounts.set(display.id, emptyCount);
        if (emptyCount < 3) continue;
        throw new Error(`Display ${display.id} returned an empty screen capture despite granted permission`);
      }
      this.emptyCaptureCounts.delete(display.id);

      for (const target of displayTargets) {
        const cropped = cropForTarget(source.thumbnail, target);
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
        });
      }
    }
    return results;
  }

  reset(): void {
    this.hashes.clear();
    this.emptyCaptureCounts.clear();
  }
}
