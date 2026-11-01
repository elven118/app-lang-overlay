import { randomUUID } from 'node:crypto';
import { type CaptureGeometry } from './ocr-positions';
import type {
  OverlaySettings,
  StreamStatus,
  TranslationClear,
  DesktopTranslationResult,
} from '../shared/types';
import {
  encodeImageEnvelope,
  parseServerMessage,
  type FrameImageHeader,
  type ServerMessage,
} from './protocol';

type RawWebSocketData = string | Buffer | ArrayBuffer | Buffer[];
type WebSocketLike = {
  readyState: number;
  send: (data: string | Buffer) => void;
  close: () => void;
  on: {
    (event: 'open', listener: () => void): void;
    (event: 'message', listener: (data: RawWebSocketData) => void): void;
    (event: 'error', listener: (error: Error) => void): void;
    (event: 'close', listener: () => void): void;
  };
};
type WebSocketConstructor = {
  new (url: string, options?: { headers?: Record<string, string> }): WebSocketLike;
  OPEN: number;
};

// `ws` is already a runtime dependency. Keeping its narrow surface typed here
// avoids requiring a separate type-only package in production installs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocketClient = require('ws') as WebSocketConstructor;

export type CapturedFrame = {
  regionId: string;
  width: number;
  height: number;
  jpeg: Buffer;
  geometry?: CaptureGeometry;
};

type DesktopStreamOptions = {
  appVersion: string;
  getSettings: () => OverlaySettings;
  captureFrames: () => Promise<CapturedFrame[]>;
  onResult: (result: DesktopTranslationResult) => void;
  onClear: (message: TranslationClear) => void;
  onStatus: (status: StreamStatus) => void;
};

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

function normalizeEndpoint(value: string): string {
  const url = new URL(value || 'ws://127.0.0.1:8765/v1/stream');
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Backend URL must use ws:// or wss://');
  }
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/v1/stream';
  }
  return url.toString();
}

function rawDataToText(raw: RawWebSocketData): string | null {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return null;
}

export class DesktopStream {
  private socket: WebSocketLike | null = null;
  private sessionId = '';
  private frameNumber = 0n;
  private requestNumber = 0;
  private captureTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = true;
  private ready = false;
  private paused = false;
  private captureRunningSession: string | null = null;
  private captureFailed = false;
  private endpoint = '';
  private latestResultFrame = new Map<string, bigint>();
  private frameGeometry = new Map<string, CaptureGeometry>();

  constructor(private readonly options: DesktopStreamOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocketClient.OPEN && this.sessionId) {
      socket.send(JSON.stringify({
        type: 'session.end',
        requestId: this.nextRequestId('end'),
        sessionId: this.sessionId,
      }));
    }
    socket?.close();
  }

  applySettings(previous: OverlaySettings, next: OverlaySettings): void {
    const connectionChanged = previous.backendUrl !== next.backendUrl
      || previous.backendToken !== next.backendToken
      || previous.mode !== next.mode;
    if (connectionChanged) {
      this.reconnectNow();
      return;
    }
    if (
      this.ready
      && (previous.ocrLang !== next.ocrLang || previous.targetLanguage !== next.targetLanguage)
    ) {
      this.sendJson({
        type: 'session.update',
        requestId: this.nextRequestId('update'),
        sessionId: this.sessionId,
        settings: {
          sourceLanguage: next.ocrLang,
          targetLanguage: next.targetLanguage,
        },
      });
    }
    if (previous.polling_ms !== next.polling_ms || previous.mode !== next.mode) {
      this.scheduleCapture(0);
    }
  }

  togglePaused(): boolean {
    this.setPaused(!this.paused);
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (this.ready) {
      this.sendJson({
        type: paused ? 'session.pause' : 'session.resume',
        requestId: this.nextRequestId(paused ? 'pause' : 'resume'),
        sessionId: this.sessionId,
      });
    }
    if (paused) {
      this.clearCaptureTimer();
      this.report({ state: 'paused', message: 'Capture paused' });
    } else if (this.ready) {
      this.report({ state: 'online', message: 'Connected' });
      this.scheduleCapture(0);
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  refreshCapture(): void {
    this.reconnectNow();
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    this.ready = false;
    this.sessionId = `desktop-${randomUUID()}`;
    this.latestResultFrame.clear();
    this.frameGeometry.clear();

    const settings = this.options.getSettings();
    try {
      this.endpoint = normalizeEndpoint(settings.backendUrl);
    } catch (error) {
      this.report({ state: 'error', message: error instanceof Error ? error.message : 'Invalid backend URL' });
      this.scheduleReconnect();
      return;
    }

    this.report({ state: 'connecting', message: `Connecting to ${this.endpoint}` });
    const headers = settings.backendToken
      ? { Authorization: `Bearer ${settings.backendToken}` }
      : undefined;
    const socket = new WebSocketClient(this.endpoint, { headers });
    this.socket = socket;

    socket.on('open', () => {
      if (socket !== this.socket) return;
      this.sendJson({
        type: 'client.hello',
        protocolVersion: 1,
        clientKind: 'desktop',
        appVersion: this.options.appVersion,
        ocrProviders: ['server-onnx'],
      });
    });
    socket.on('message', (raw) => {
      if (socket !== this.socket) return;
      const text = rawDataToText(raw);
      const message = text === null ? null : parseServerMessage(text);
      if (message) this.handleMessage(message);
    });
    socket.on('error', (error) => {
      if (socket !== this.socket) return;
      this.report({ state: 'offline', message: `Backend connection error: ${error.message}` });
    });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.ready = false;
      this.clearCaptureTimer();
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private handleMessage(message: ServerMessage): void {
    if (message.type === 'server.ready') {
      if (message.protocolVersion !== 1 || !message.ocrProviders.includes('server-onnx')) {
        this.report({ state: 'error', message: 'Backend does not support protocol v1 server ONNX OCR' });
        this.socket?.close();
        return;
      }
      const settings = this.options.getSettings();
      this.sendJson({
        type: 'session.start',
        requestId: this.nextRequestId('start'),
        sessionId: this.sessionId,
        sourceLanguage: settings.ocrLang,
        targetLanguage: settings.targetLanguage,
        imageUploadConsent: true,
      });
      return;
    }

    if (message.type === 'session.state' && message.sessionId === this.sessionId) {
      this.ready = true;
      this.reconnectAttempt = 0;
      if (this.paused && !message.paused) {
        this.sendJson({
          type: 'session.pause',
          requestId: this.nextRequestId('pause'),
          sessionId: this.sessionId,
        });
        this.report({ state: 'paused', message: 'Capture paused' });
        return;
      }
      this.paused = message.paused;
      this.report(message.paused
        ? { state: 'paused', message: 'Capture paused' }
        : { state: 'online', message: 'Connected' });
      if (!message.paused) this.scheduleCapture(0);
      return;
    }

    if (message.type === 'translation.result' && message.sessionId === this.sessionId) {
      const frame = BigInt(message.frameId);
      const accepted = this.latestResultFrame.get(message.regionId) ?? -1n;
      if (frame <= accepted) return;
      this.latestResultFrame.set(message.regionId, frame);
      const geometry = this.frameGeometry.get(message.frameId);
      this.frameGeometry.delete(message.frameId);
      const captureBounds = geometry?.screenBoundsDip ??
        (geometry?.sourceKind === 'display' ? geometry.displayBoundsDip : undefined);
      this.options.onResult({ ...message, captureBounds });
      return;
    }

    if (message.type === 'translation.clear' && message.sessionId === this.sessionId) {
      const frame = BigInt(message.frameId);
      const accepted = this.latestResultFrame.get(message.regionId) ?? -1n;
      if (frame < accepted) return;
      this.latestResultFrame.set(message.regionId, frame);
      this.options.onClear(message);
      return;
    }

    if (message.type === 'error') {
      console.error(`[desktop-stream] ${message.code}: ${message.message}`);
      this.report({
        state: 'error',
        message: `${message.code}: ${message.message}`,
      });
    }
  }

  private scheduleCapture(delay?: number): void {
    this.clearCaptureTimer();
    if (this.stopped || !this.ready || this.paused) return;
    const pollingMs = this.options.getSettings().polling_ms;
    this.captureTimer = setTimeout(() => void this.captureOnce(), delay ?? pollingMs);
  }

  private async captureOnce(): Promise<void> {
    if (this.captureRunningSession === this.sessionId || this.stopped || !this.ready || this.paused) {
      this.scheduleCapture();
      return;
    }
    const captureSessionId = this.sessionId;
    this.captureRunningSession = captureSessionId;
    try {
      const frames = await this.options.captureFrames();
      if (captureSessionId !== this.sessionId) return;
      if (this.captureFailed) {
        this.captureFailed = false;
        this.report({ state: 'online', message: 'Connected' });
      }
      for (const frame of frames) {
        if (!this.ready || this.paused || !this.socket || this.socket.readyState !== WebSocketClient.OPEN) break;
        this.frameNumber += 1n;
        const frameId = this.frameNumber.toString();
        if (frame.geometry) {
          this.frameGeometry.set(frameId, frame.geometry);
          // Results may skip queued frames; retain only bounded metadata, never images.
          if (this.frameGeometry.size > 256) {
            this.frameGeometry.delete(this.frameGeometry.keys().next().value!);
          }
        }
        const header: FrameImageHeader = {
          type: 'frame.image',
          sessionId: this.sessionId,
          regionId: frame.regionId,
          frameId,
          capturedAtMs: Date.now(),
          frameWidth: frame.width,
          frameHeight: frame.height,
          mimeType: 'image/jpeg',
          clientOcrDiagnostics: {
            provider: 'none',
            reason: 'server-ocr',
          },
        };
        this.socket.send(encodeImageEnvelope(header, frame.jpeg));
      }
    } catch (error) {
      // Stopping/replacing a capture worker intentionally rejects pending work.
      if (this.stopped || this.paused || !this.ready || captureSessionId !== this.sessionId) return;
      const message = error instanceof Error ? error.message : 'Screen capture failed';
      if (!this.captureFailed) {
        console.error('[desktop-capture]', error);
        this.report({ state: 'error', message });
      }
      this.captureFailed = true;
    } finally {
      // An old worker may finish after a mode switch. It must not clear the
      // new session's in-flight guard or replace its scheduled sample.
      if (this.captureRunningSession === captureSessionId) {
        this.captureRunningSession = null;
        if (this.sessionId === captureSessionId) this.scheduleCapture();
      }
    }
  }

  private reconnectNow(): void {
    this.clearTimers();
    this.ready = false;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.reconnectAttempt = 0;
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const retryInMs = RECONNECT_DELAYS_MS[index];
    this.reconnectAttempt += 1;
    this.report({ state: 'offline', message: 'Backend offline; keeping the last translation', retryInMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, retryInMs);
  }

  private sendJson(payload: object): void {
    if (this.socket?.readyState === WebSocketClient.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private nextRequestId(kind: string): string {
    this.requestNumber += 1;
    return `desktop-${kind}-${this.requestNumber}`;
  }

  private report(status: StreamStatus): void {
    this.options.onStatus(status);
  }

  private clearCaptureTimer(): void {
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearTimers(): void {
    this.clearCaptureTimer();
    this.clearReconnectTimer();
  }
}
