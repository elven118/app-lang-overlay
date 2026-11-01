import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { nativeImage, type Display, type NativeImage } from 'electron';

// ScreenCaptureKit filters overlay windows before composition. Cropping or
// masking already-composited pixels cannot recover the content underneath them.
export class MacDisplayCapture {
  private child?: ChildProcess;
  private disposed = false;

  constructor(private readonly display: Display, private readonly excludedWindowIds: () => string[]) {}

  async capture(): Promise<NativeImage> {
    if (this.disposed) throw new Error('Display capture was stopped');
    const scale = this.display.scaleFactor || 1;
    const args = [String(this.display.id), String(Math.round(this.display.bounds.width * scale)),
      String(Math.round(this.display.bounds.height * scale)), this.excludedWindowIds().join(',')];
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      this.child = execFile(path.join(__dirname, 'native/macos/display-capture'), args,
        { encoding: 'buffer', timeout: 17000, maxBuffer: 128 * 1024 * 1024 }, (error, stdout, stderr) => {
          this.child = undefined;
          if (error) reject(new Error(`Display ${this.display.id}: ${stderr.toString().trim() || error.message}`));
          else resolve(stdout);
        });
    });
    if (this.disposed) throw new Error('Display capture was stopped');
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error(`Display ${this.display.id}: ScreenCaptureKit returned an empty image`);
    return image;
  }

  dispose(): void {
    this.disposed = true;
    this.child?.kill();
    this.child = undefined;
  }
}
