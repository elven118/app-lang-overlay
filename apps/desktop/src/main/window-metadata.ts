import path from 'node:path';

export function windowMetadataCommand(dist: string, once = false): { binary: string; args: string[] } {
  if (process.platform === 'win32') {
    return { binary: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', '-File', path.join(dist, 'native/windows/window-picker.ps1'),
      '-ExcludedProcessId', String(process.pid), ...(once ? ['-Once'] : [])] };
  }
  if (process.platform === 'darwin') {
    return { binary: path.join(dist, 'native/macos/window-picker'), args: [String(process.pid), ...(once ? ['--once'] : [])] };
  }
  throw new Error('Hover window selection supports Windows and macOS.');
}
