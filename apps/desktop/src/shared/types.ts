export type CaptureRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type CaptureMode = 'full_screen' | 'one_large_area' | 'multiple_regions';

export type ProfileState = {
  activeProfileId: string;
  profiles: string[];
};

export type SourceLanguage = 'auto' | 'en' | 'ja' | 'ko' | 'zh-Hans' | 'zh-Hant';
export type TargetLanguage = 'en' | 'zh-Hant' | 'ja';

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
  ocrLang: SourceLanguage;
  targetLanguage: TargetLanguage;
  mode: CaptureMode;
  polling_ms: number;
  backendUrl: string;
  backendToken: string;
  captureRegion?: CaptureRegion;
  captureRegions?: CaptureRegion[];
};

export type NormalizedBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SourceReadingSegment = {
  text: string;
  reading: string | null;
};

export type TranslationBlock = {
  id: string;
  text: string;
  translatedText: string;
  sourceReadingSegments: SourceReadingSegment[] | null;
  confidence: number;
  bounds: NormalizedBounds;
  readingOrder: number;
};

export type TranslationResult = {
  type: 'translation.result';
  sessionId: string;
  regionId: string;
  frameId: string;
  ocrProvider: 'tesseract' | 'google-mlkit' | 'device-ocr' | 'vision-ocr' | 'replaykit' | 'server-onnx';
  blocks: TranslationBlock[];
  combinedSourceText: string;
  combinedTranslatedText: string;
  dedupeKey: string;
  timingMs: {
    ocr: number;
    translation: number;
    total: number;
  };
};

export type TranslationClear = {
  type: 'translation.clear';
  sessionId: string;
  regionId: string;
  frameId: string;
  reason: 'stable-empty' | 'region-removed' | 'session-ended';
};

export type StreamStatus = {
  state: 'connecting' | 'online' | 'offline' | 'paused' | 'error';
  message: string;
  retryInMs?: number;
};
