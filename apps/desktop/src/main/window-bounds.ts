import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesktopRect } from '../shared/types';
import { screen } from 'electron';
import { windowMetadataCommand } from './window-metadata';

const execute = promisify(execFile);

// Reuse the picker's native metadata helper. Never derive global positions from
// uploaded image pixels: Retina scaling and JPEG resizing change those units.
export async function readWindowBounds(sourceId: string): Promise<DesktopRect | undefined> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return undefined;
  const command = windowMetadataCommand(__dirname, true);
  const { stdout } = await execute(command.binary, command.args,
    { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' });
  const windows = JSON.parse(stdout) as { id: number; bounds: DesktopRect }[];
  const bounds = windows.find((win) => String(win.id) === sourceId.split(':')[1])?.bounds;
  return bounds && process.platform === 'win32' ? screen.screenToDipRect(null, bounds) : bounds;
}
