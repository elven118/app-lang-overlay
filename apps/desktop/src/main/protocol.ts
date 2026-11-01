import type { TranslationClear, TranslationResult } from '../shared/types';

export const IMAGE_ENVELOPE_MAGIC = Buffer.from('ALO1', 'ascii');
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_HEADER_BYTES = 64 * 1024;

export type FrameImageHeader = {
  type: 'frame.image';
  sessionId: string;
  regionId: string;
  frameId: string;
  capturedAtMs: number;
  frameWidth: number;
  frameHeight: number;
  mimeType: 'image/jpeg';
  clientOcrDiagnostics: Record<string, string>;
};

export type ServerReady = {
  type: 'server.ready';
  protocolVersion: 1;
  ocrProviders: string[];
};

export type SessionState = {
  type: 'session.state';
  requestId: string;
  sessionId: string;
  sourceLanguage: string;
  targetLanguage: string;
  imageUploadConsent: boolean;
  paused: boolean;
};

export type ErrorMessage = {
  type: 'error';
  code: string;
  message: string;
  retryable: boolean;
  requestId?: string;
  sessionId?: string;
  regionId?: string;
  frameId?: string;
};

export type ServerMessage = ServerReady | SessionState | TranslationResult | TranslationClear | ErrorMessage | {
  type: 'pong';
  requestId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFrameId(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function isTranslationResult(value: Record<string, unknown>): value is TranslationResult {
  return typeof value.sessionId === 'string'
    && typeof value.regionId === 'string'
    && isFrameId(value.frameId)
    && typeof value.ocrProvider === 'string'
    && Array.isArray(value.blocks)
    && typeof value.combinedSourceText === 'string'
    && typeof value.combinedTranslatedText === 'string'
    && typeof value.dedupeKey === 'string'
    && isRecord(value.timingMs);
}

export function encodeImageEnvelope(header: FrameImageHeader, jpeg: Buffer): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.length === 0 || headerBytes.length > MAX_HEADER_BYTES) {
    throw new Error('Frame image header exceeds the 64 KiB protocol limit');
  }
  if (jpeg.length === 0 || jpeg.length > MAX_IMAGE_BYTES) {
    throw new Error('JPEG exceeds the 4 MiB protocol limit');
  }
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(headerBytes.length, 0);
  return Buffer.concat([IMAGE_ENVELOPE_MAGIC, length, headerBytes, jpeg]);
}

export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  if (value.type === 'server.ready') {
    return value.protocolVersion === 1 && Array.isArray(value.ocrProviders) ? value as ServerReady : null;
  }
  if (value.type === 'session.state') {
    return typeof value.requestId === 'string'
      && typeof value.sessionId === 'string'
      && typeof value.paused === 'boolean'
      ? value as SessionState
      : null;
  }
  if (value.type === 'translation.result') {
    return isTranslationResult(value) ? value : null;
  }
  if (value.type === 'translation.clear') {
    return typeof value.sessionId === 'string'
      && typeof value.regionId === 'string'
      && isFrameId(value.frameId)
      && typeof value.reason === 'string'
      ? value as TranslationClear
      : null;
  }
  if (value.type === 'error') {
    return typeof value.code === 'string'
      && typeof value.message === 'string'
      && typeof value.retryable === 'boolean'
      ? value as ErrorMessage
      : null;
  }
  if (value.type === 'pong') {
    return typeof value.requestId === 'string' ? value as ServerMessage : null;
  }
  return null;
}
