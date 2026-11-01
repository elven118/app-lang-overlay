import type { DesktopRect, NormalizedBounds, TranslationResult } from '../shared/types';

export type CaptureGeometry = {
  sourceKind: 'display';
  displayId: number;
  displayBoundsDip: { x: number; y: number; width: number; height: number };
  displayScaleFactor: number;
  imageWidth: number;
  imageHeight: number;
  screenBoundsDip?: DesktopRect;
} | {
  sourceKind: 'window';
  windowId: string;
  windowName: string;
  imageWidth: number;
  imageHeight: number;
  screenBoundsDip?: DesktopRect;
};

function project(bounds: NormalizedBounds, width: number, height: number, x = 0, y = 0) {
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    x: round(x + bounds.x * width),
    y: round(y + bounds.y * height),
    width: round(bounds.width * width),
    height: round(bounds.height * height),
  };
}
