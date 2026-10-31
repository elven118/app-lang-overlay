import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DesktopRect } from '../shared/types';

const execute = promisify(execFile);

// Reuse the picker's native metadata helper. Never derive global positions from
// uploaded image pixels: Retina scaling and JPEG resizing change those units.
export async function readWindowBounds(sourceId: string): Promise<DesktopRect | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const { stdout } = await execute(path.join(__dirname, 'native/window-picker'),
    [String(process.pid), '--once'], { timeout: 2000, maxBuffer: 1024 * 1024 });
  const windows = JSON.parse(stdout) as { id: number; bounds: DesktopRect }[];
  return windows.find((win) => String(win.id) === sourceId.split(':')[1])?.bounds;
}
