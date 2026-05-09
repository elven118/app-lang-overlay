export type CaptureRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type OverlaySettings = {
  showSource: boolean;
  position: 'top' | 'bottom';
  offsetX: number;
  offsetY: number;
  width: number;
  sourceFontSize: number;
  translatedFontSize: number;
  lineGap: number;
  textColor: string;
  translateColor: string;
  background: string;
  autoHideMs: number;
  dedupeWindowMs: number;
  clickthrough: boolean;
  ocrLang: string;
};
