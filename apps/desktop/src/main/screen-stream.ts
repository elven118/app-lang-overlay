import path from 'node:path';
import { BrowserWindow, desktopCapturer, nativeImage, session, type Display, type NativeImage } from 'electron';

// A dedicated, hidden media worker. Main owns the selected source and sampling;
// this window only decodes the continuous video stream into frames in memory.
export class ScreenStream {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private waitingSince: number | null = null;

  private get sourceLabel(): string {
    return this.windowSourceId ? 'Selected window' : `Display ${this.display.id}`;
  }

  private async runWorker(worker: BrowserWindow, operation: 'start' | 'snapshot', args: object | null = null): Promise<unknown> {
    // Electron replaces a rejected executeJavaScript promise with a generic
    // error. Catch inside the worker so its actual DOMException crosses intact.
    const reply = await worker.webContents.executeJavaScript(`(async () => {
      try {
        if (!window.screenCapture) throw new Error('Capture worker is not initialized; rebuild the desktop app');
        return { ok: true, value: await window.screenCapture.${operation}(${args ? JSON.stringify(args) : ''}) };
      } catch (error) {
        return { ok: false, name: String(error?.name || 'Error'), message: String(error?.message || error) };
      }
    })()`, operation === 'start');
    if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
      throw new Error(`${this.sourceLabel} capture worker returned an invalid ${operation} response`);
    }
    if (!reply.ok) {
      throw new Error(`${this.sourceLabel} capture ${operation} failed: ${reply.name}: ${reply.message}`);
    }
    return reply.value;
  }

  constructor(private readonly display: Display, private readonly workerPage: string, private readonly windowSourceId?: string) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const captureSession = session.fromPartition(`overlay-capture-${this.windowSourceId || this.display.id}`);
    const worker = new BrowserWindow({
      show: false, width: 1, height: 1, skipTaskbar: true, focusable: false,
      webPreferences: {
        session: captureSession, nodeIntegration: false, contextIsolation: true,
        sandbox: true, backgroundThrottling: false,
      },
    });
    this.window = worker;
    worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    worker.webContents.on('will-navigate', (event) => event.preventDefault());
    captureSession.setDisplayMediaRequestHandler((request, callback) => {
      if (worker.isDestroyed() || request.frame !== worker.webContents.mainFrame || !request.videoRequested || request.audioRequested) {
        callback({});
        return;
      }
      // Enumerate IDs only. Empty preview thumbnails are irrelevant to a stream.
      void desktopCapturer.getSources({
        types: [this.windowSourceId ? 'window' : 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false,
      }).then((sources) => {
        const source = sources.find((item) => this.windowSourceId
          ? item.id === this.windowSourceId
          : item.display_id === String(this.display.id));
        callback(source && !worker.isDestroyed() ? { video: source } : {});
      }).catch(() => callback({}));
    }, { useSystemPicker: false });

    const size = this.windowSourceId ? {} : {
      width: Math.round(this.display.bounds.width * this.display.scaleFactor),
      height: Math.round(this.display.bounds.height * this.display.scaleFactor),
    };
    this.ready = worker.loadFile(this.workerPage).then(async () => {
      await this.runWorker(worker, 'start', size);
    });
    return this.ready;
  }

  async capture(): Promise<NativeImage | null> {
    await this.start();
    const worker = this.window;
    if (!worker || worker.isDestroyed()) throw new Error(`${this.sourceLabel} stream was closed`);
    const dataUrl = await this.runWorker(worker, 'snapshot');
    if (dataUrl === null) {
      this.waitingSince ??= Date.now();
      if (Date.now() - this.waitingSince >= 15000) {
        throw new Error(`${this.sourceLabel} is unavailable: no usable video frame for 15 seconds. Restore the window or choose it again.`);
      }
      return null;
    }
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error(`${this.sourceLabel} stream returned an invalid frame`);
    }
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) throw new Error(`${this.sourceLabel} stream returned an empty frame`);
    this.waitingSince = null;
    return image;
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) {
      if (!this.window.webContents.isDestroyed()) {
        this.window.webContents.session.setDisplayMediaRequestHandler(null);
      }
      // Destroying the worker releases its MediaStream tracks as well.
      this.window.destroy();
    }
    this.window = null;
    this.ready = null;
    this.waitingSince = null;
  }
}

export function captureWorkerPage(): string {
  return path.join(__dirname, 'renderer/capture/index.html');
}
