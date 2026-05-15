export type CaptureRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PlacementMode = 'above' | 'free';

export type OverlayPlacement = {
  above: {
    xShift: number;
    gapY: number;
  };
  free: {
    x: number;
    y: number;
  };
};

export type OverlaySettings = {
  showSource: boolean;
  placementMode: PlacementMode;
  placement: OverlayPlacement;
  width: number;
  sourceFontSize: number;
  translatedFontSize: number;
  lineGap: number;
  textColor: string;
  translateColor: string;
  background: string;
  autoHideMs: number;
  clickthrough: boolean;
  ocrLang: string;
  captureRegion?: CaptureRegion;
};
