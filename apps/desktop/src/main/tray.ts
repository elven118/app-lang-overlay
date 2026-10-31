import { Menu, nativeImage, Tray } from 'electron';

function createTrayIcon() {
  // Draw OCR brackets and text lines at 1x and 2x without an external asset.
  const icon = nativeImage.createEmpty();
  const strokes = [
    [1, 2, 4, 2], [1, 2, 2, 12], [1, 12, 4, 2],
    [11, 2, 4, 2], [13, 2, 2, 12], [11, 12, 4, 2],
    [5, 5, 6, 1], [5, 8, 6, 1], [5, 10, 4, 1],
  ];
  for (const scaleFactor of [1, 2]) {
    const size = 16 * scaleFactor;
    const pixels = Buffer.alloc(size * size * 4);
    for (const [left, top, width, height] of strokes) {
      for (let y = top * scaleFactor; y < (top + height) * scaleFactor; y += 1) {
        for (let x = left * scaleFactor; x < (left + width) * scaleFactor; x += 1) {
          const offset = (y * size + x) * 4;
          if (process.platform !== 'darwin') {
            // BGRA bitmap; blue on Windows/Linux, a template mask on macOS.
            pixels[offset] = 255;
            pixels[offset + 1] = 190;
            pixels[offset + 2] = 65;
          }
          pixels[offset + 3] = 255;
        }
      }
    }
    const bitmap = nativeImage.createFromBitmap(pixels, { width: size, height: size });
    icon.addRepresentation({ scaleFactor, buffer: bitmap.toPNG() });
  }
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
}

export function createAppTray(showControlWindow: () => void, quit: () => void): Tray {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip('App Lang Overlay');
  const menu = Menu.buildFromTemplate([
    { label: 'Show Controls', click: showControlWindow },
    { type: 'separator' },
    { label: 'Quit', click: quit },
  ]);
  tray.on('click', showControlWindow);
  // Attaching a permanent context menu on macOS consumes the normal click.
  if (process.platform === 'linux') tray.setContextMenu(menu);
  else tray.on('right-click', () => tray.popUpContextMenu(menu));
  return tray;
}
