import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import path from 'node:path';
import { BrowserWindow, ipcMain, screen, type Rectangle, type WebContents } from 'electron';
import type { WindowHover } from '../shared/types';
import { windowMetadataCommand } from './window-metadata';

export interface NativeWindow {
  id: number;
  name: string;
  bounds: Rectangle;
}

// Both native helpers return windows in front-to-back order.
export function windowAtPoint(windows: NativeWindow[], point: { x: number; y: number }): NativeWindow | undefined {
  return windows.find(({ bounds: b }) => point.x >= b.x && point.y >= b.y &&
    point.x < b.x + b.width && point.y < b.y + b.height);
}

export class HoverWindowPicker {
  private windows: BrowserWindow[] = [];
  private nativeWindows: NativeWindow[] = [];
  private helper?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private timer?: ReturnType<typeof setInterval>;
  private selecting = false;
  private disposed = false;
  private error = '';

  constructor(private readonly dist: string, private readonly select: (windowId: number) => Promise<void>) {}

  async start(): Promise<void> {
    const command = windowMetadataCommand(this.dist);
    ipcMain.handle('window-picker:state', (event) => {
      if (!this.owns(event.sender)) throw new Error('Window picker is not active');
      return this.state(event.sender);
    });
    ipcMain.handle('window-picker:select', async (event) => {
      if (!this.owns(event.sender) || this.selecting) return false;
      const target = windowAtPoint(this.nativeWindows, screen.getCursorScreenPoint());
      if (!target) return false;
      this.selecting = true;
      try {
        await this.select(target.id);
        return true;
      } catch (error) {
        if (!this.disposed) {
          this.error = error instanceof Error ? error.message : String(error);
          if (this.onError) this.onError(new Error(this.error));
          else this.publish();
        }
        return false;
      } finally { this.selecting = false; }
    });
    ipcMain.handle('window-picker:cancel', (event) => {
      if (this.owns(event.sender)) this.cancel();
    });
    try {
      this.helper = spawn(command.binary, command.args, { stdio: 'pipe', windowsHide: true });
      // Drain diagnostics so an error cannot block the helper's pipe.
      this.helper.stderr.on('data', () => {});
      this.lines = createInterface({ input: this.helper.stdout });
      this.lines.on('line', (line) => {
        try {
          const windows = JSON.parse(line) as NativeWindow[];
          if (!Array.isArray(windows)) throw new Error('Expected window list');
          this.nativeWindows = windows;
          if (process.platform === 'win32') this.nativeWindows = this.nativeWindows.map((win) => ({
            ...win, bounds: screen.screenToDipRect(null, win.bounds),
          }));
          this.error = '';
        } catch {
          this.nativeWindows = [];
          this.error = 'Could not read window positions. Cancel and try again.';
        }
      });
      this.helper.on('error', (error) => {
        this.nativeWindows = [];
        this.error = `Window detection failed: ${error.message}. Run npm run build again.`;
        if (this.onError) this.onError(new Error(this.error));
        else this.publish();
      });
      this.helper.on('exit', () => {
        if (this.disposed) return;
        this.nativeWindows = [];
        this.error = 'Window detection stopped. Cancel and try again.';
        if (this.onError) this.onError(new Error(this.error));
        else this.publish();
      });
      this.timer = setInterval(() => this.publish(), 50);
      await Promise.all(screen.getAllDisplays().map(async (display) => {
        const win = new BrowserWindow({
          ...display.bounds, show: false, frame: false, transparent: true, hasShadow: false,
          resizable: false, movable: false, minimizable: false, maximizable: false,
          alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
          webPreferences: { contextIsolation: true, nodeIntegration: false,
            preload: path.join(this.dist, 'preload/index.js') },
        });
        this.windows.push(win);
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.webContents.on('before-input-event', (_event, input) => {
          if (input.key === 'Escape') this.cancel();
        });
        win.on('closed', () => { if (!this.disposed) this.cancel(); });
        await win.loadFile(path.join(this.dist, 'renderer/window-picker/index.html'));
        if (!this.disposed && !win.isDestroyed()) win.show();
      }));
      const cursor = screen.getCursorScreenPoint();
      this.windows.find((win) => {
        const b = win.getBounds();
        return cursor.x >= b.x && cursor.y >= b.y && cursor.x < b.x + b.width && cursor.y < b.y + b.height;
      })?.focus();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  // Main process provides cancellation so the previous selection/settings survive.
  onCancel: () => void = () => this.dispose();
  onError?: (error: Error) => void;
  private cancel(): void { this.onCancel(); }
  private owns(sender: WebContents): boolean {
    return !this.disposed && this.windows.some((win) => !win.isDestroyed() && win.webContents === sender);
  }
  private state(sender: WebContents): WindowHover {
    const target = windowAtPoint(this.nativeWindows, screen.getCursorScreenPoint());
    const picker = this.windows.find((win) => !win.isDestroyed() && win.webContents === sender)!;
    const origin = picker.getBounds();
    return { name: target?.name || '', error: this.error, bounds: target ? {
      x: target.bounds.x - origin.x, y: target.bounds.y - origin.y,
      width: target.bounds.width, height: target.bounds.height,
    } : null };
  }
  private publish(): void {
    if (this.disposed) return;
    for (const win of this.windows) {
      if (!win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
        win.webContents.send('window-picker:hover', this.state(win.webContents));
      }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.lines?.close();
    this.helper?.kill();
    for (const channel of ['window-picker:state', 'window-picker:select', 'window-picker:cancel']) ipcMain.removeHandler(channel);
    this.windows.forEach((win) => { if (!win.isDestroyed()) win.destroy(); });
    this.windows = [];
  }
}
