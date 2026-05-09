type SubtitleEvent = {
  type: 'subtitle';
  profile: string;
  timestamp: number;
  source_text: string;
  translated_text: string | null;
  lang_src: string;
  lang_dst: string;
  confidence: number;
  dedupe_key: string;
  hide_after_ms?: number;
};

type ClearEvent = {
  type: 'clear';
  profile: string;
  timestamp: number;
  reason?: string;
};

type HealthEvent = {
  type: 'health';
  timestamp: number;
  status?: string;
};

type OverlayEvent = SubtitleEvent | ClearEvent | HealthEvent;

import type { OverlaySettings } from '../../shared/types';

const sourceEl = document.getElementById('source') as HTMLDivElement;
const translatedEl = document.getElementById('translated') as HTMLDivElement;
const box = document.getElementById('subtitle-box') as HTMLDivElement;
const root = document.getElementById('root') as HTMLDivElement;
const panel = document.getElementById('settings-panel') as HTMLDivElement;
const selectionArea = document.getElementById('selection-area') as HTMLDivElement;

const positionInput = document.getElementById('setting-position') as HTMLSelectElement;
const widthInput = document.getElementById('setting-width') as HTMLInputElement;
const showSourceInput = document.getElementById('setting-show-source') as HTMLInputElement;
const sourceFontSizeInput = document.getElementById('setting-source-font-size') as HTMLInputElement;
const translatedFontSizeInput = document.getElementById('setting-translated-font-size') as HTMLInputElement;
const textColorInput = document.getElementById('setting-text-color') as HTMLInputElement;
const translateColorInput = document.getElementById('setting-translate-color') as HTMLInputElement;
const backgroundColorInput = document.getElementById('setting-background-color') as HTMLInputElement;
const backgroundAlphaInput = document.getElementById('setting-background-alpha') as HTMLInputElement;
const autoHideInput = document.getElementById('setting-autohide') as HTMLInputElement;
const dedupeInput = document.getElementById('setting-dedupe') as HTMLInputElement;
const ocrLangInput = document.getElementById('setting-ocr-lang') as HTMLSelectElement;
const clickthroughInput = document.getElementById('setting-clickthrough') as HTMLInputElement;

let ws: WebSocket | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let settings: OverlaySettings;
let gameId = 'demo';
let panelVisible = false;
let latestSourceText = '';
let latestTranslatedText = '';
let dragging = false;
const dedupeSeen = new Map<string, number>();

function syncSelectionArea(nextSettings: OverlaySettings): void {
  const region = nextSettings.captureRegion;
  if (!region || region.width <= 0 || region.height <= 0) {
    selectionArea.classList.add('hidden');
    return;
  }

  selectionArea.style.left = `${region.left}px`;
  selectionArea.style.top = `${region.top}px`;
  selectionArea.style.width = `${region.width}px`;
  selectionArea.style.height = `${region.height}px`;

  if (panelVisible) {
    selectionArea.classList.remove('hidden');
  }
}

function setStyle(nextSettings: OverlaySettings): void {
  document.documentElement.style.setProperty('--source-font-size', `${nextSettings.sourceFontSize}px`);
  document.documentElement.style.setProperty('--translated-font-size', `${nextSettings.translatedFontSize}px`);
  document.documentElement.style.setProperty('--line-gap', `${nextSettings.lineGap}px`);
  document.documentElement.style.setProperty('--text-color', nextSettings.textColor);
  document.documentElement.style.setProperty('--translate-color', nextSettings.translateColor);
  document.documentElement.style.setProperty('--bg', nextSettings.background);
  document.documentElement.style.setProperty('--offset-x', `${nextSettings.offsetX}px`);
  document.documentElement.style.setProperty('--offset-y', `${nextSettings.offsetY}px`);
  document.documentElement.style.setProperty('--width', `${nextSettings.width}px`);
  document.documentElement.style.setProperty('--show-source', nextSettings.showSource ? 'block' : 'none');
  if (nextSettings.position === 'top') {
    root.classList.remove('anchor-bottom');
    root.classList.add('anchor-top');
  } else {
    root.classList.remove('anchor-top');
    root.classList.add('anchor-bottom');
  }
  syncSelectionArea(nextSettings);
}

function show(sourceText: string, translatedText: string | null, hideAfterMs: number | undefined): void {
  latestSourceText = sourceText || '';
  latestTranslatedText = translatedText || '';
  if (sourceEl) sourceEl.textContent = sourceText;
  translatedEl.textContent = translatedText || '';
  box.classList.remove('hidden');
  box.classList.add('visible');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hide(), hideAfterMs || settings.autoHideMs);
}

async function copyCurrentText(): Promise<void> {
  const text = (latestTranslatedText || latestSourceText || '').trim();
  if (!text) {
    show('Nothing to copy', '', 900);
    return;
  }
  const ok = await window.overlayApi.copyText(text);
  if (ok) {
    show('Copied to clipboard', text, 1200);
  }
}

function hide(): void {
  box.classList.remove('visible');
  box.classList.add('hidden');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.trim().replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((ch) => ch + ch).join('')
    : normalized;
  const safe = /^[0-9a-fA-F]{6}$/.test(full) ? full : '000000';
  return {
    r: parseInt(safe.slice(0, 2), 16),
    g: parseInt(safe.slice(2, 4), 16),
    b: parseInt(safe.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function parseBackground(value: string): { colorHex: string; alphaPercent: number } {
  const rgbaMatch = value.match(/rgba?\(([^)]+)\)/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map((p) => p.trim());
    const r = Number(parts[0] || '0');
    const g = Number(parts[1] || '0');
    const b = Number(parts[2] || '0');
    const a = parts[3] === undefined ? 1 : Number(parts[3]);
    return {
      colorHex: rgbToHex(r, g, b),
      alphaPercent: clamp(Math.round((Number.isFinite(a) ? a : 1) * 100), 0, 100),
    };
  }
  if (value.startsWith('#')) {
    const rgb = hexToRgb(value);
    return { colorHex: rgbToHex(rgb.r, rgb.g, rgb.b), alphaPercent: 100 };
  }
  return { colorHex: '#000000', alphaPercent: 35 };
}

function composeBackground(): string {
  const { r, g, b } = hexToRgb(backgroundColorInput.value);
  const alpha = clamp(Number(backgroundAlphaInput.value || '35'), 0, 100) / 100;
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

function syncPanelFromSettings(): void {
  positionInput.value = settings.position;
  widthInput.value = String(settings.width);
  showSourceInput.checked = settings.showSource;
  sourceFontSizeInput.value = String(settings.sourceFontSize);
  translatedFontSizeInput.value = String(settings.translatedFontSize);
  textColorInput.value = settings.textColor.startsWith('#') ? settings.textColor : '#ffffff';
  translateColorInput.value = settings.translateColor.startsWith('#') ? settings.translateColor : '#ffd166';
  const bg = parseBackground(settings.background);
  backgroundColorInput.value = bg.colorHex;
  backgroundAlphaInput.value = String(bg.alphaPercent);
  autoHideInput.value = String(settings.autoHideMs);
  dedupeInput.value = String(settings.dedupeWindowMs);
  ocrLangInput.value = settings.ocrLang || 'en';
  clickthroughInput.checked = settings.clickthrough;
}

function parsePanelSettings(): OverlaySettings {
  return {
    ...settings,
    position: positionInput.value === 'top' ? 'top' : 'bottom',
    width: Number(widthInput.value || settings.width),
    showSource: showSourceInput.checked,
    sourceFontSize: Number(sourceFontSizeInput.value || settings.sourceFontSize),
    translatedFontSize: Number(translatedFontSizeInput.value || settings.translatedFontSize),
    textColor: textColorInput.value || settings.textColor,
    translateColor: translateColorInput.value || settings.translateColor,
    background: composeBackground(),
    autoHideMs: Number(autoHideInput.value || settings.autoHideMs),
    dedupeWindowMs: Number(dedupeInput.value || settings.dedupeWindowMs),
    ocrLang: ocrLangInput.value || settings.ocrLang || 'en',
    clickthrough: clickthroughInput.checked,
  };
}

async function persistFromPanel(): Promise<void> {
  const next = parsePanelSettings();
  settings = await window.overlayApi.saveSettings(next);
  setStyle(settings);
  syncPanelFromSettings();
  if (panelVisible) {
    await window.overlayApi.setClickthrough(false);
  }
}

async function togglePanel(nextVisible: boolean): Promise<void> {
  panelVisible = nextVisible;
  if (panelVisible) {
    await window.overlayApi.setClickthrough(false); 
    
    syncPanelFromSettings();
    panel.classList.remove('hidden');

    selectionArea.classList.remove('hidden');
    
    show('Overlay settings', 'Press Cmd/Ctrl+Shift+O to close', 4000);
  } else {
    panel.classList.add('hidden');
    selectionArea.classList.add('hidden');
    await window.overlayApi.setClickthrough(settings.clickthrough);
  }
}

function connect(): void {
  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get('ws') || 'ws://127.0.0.1:8765';
  ws = new WebSocket(wsUrl);

  ws.onmessage = (event: MessageEvent<string>) => {
    let payload: OverlayEvent;
    try {
      payload = JSON.parse(event.data) as OverlayEvent;
    } catch {
      return;
    }

    if (payload.type === 'subtitle') {
      if (payload.profile !== gameId) return;
      const seenAt = dedupeSeen.get(payload.dedupe_key);
      if (typeof seenAt === 'number' && (payload.timestamp - seenAt) * 1000 <= settings.dedupeWindowMs) {
        return;
      }
      dedupeSeen.set(payload.dedupe_key, payload.timestamp);
      show(payload.source_text, payload.translated_text, payload.hide_after_ms);
    } else if (payload.type === 'clear') {
      if (payload.profile !== gameId) return;
      hide();
    }
  };

  ws.onclose = () => {
    setTimeout(connect, 1000);
  };
}

function installPanelEvents(): void {
  const persist = () => {
    void persistFromPanel();
  };

  positionInput.addEventListener('change', persist);
  widthInput.addEventListener('change', persist);
  showSourceInput.addEventListener('change', persist);
  sourceFontSizeInput.addEventListener('change', persist);
  translatedFontSizeInput.addEventListener('change', persist);
  textColorInput.addEventListener('input', persist);
  translateColorInput.addEventListener('input', persist);
  backgroundColorInput.addEventListener('input', persist);
  backgroundAlphaInput.addEventListener('input', persist);
  autoHideInput.addEventListener('change', persist);
  dedupeInput.addEventListener('change', persist);
  ocrLangInput.addEventListener('change', persist);
  clickthroughInput.addEventListener('change', persist);

  window.overlayApi.onTogglePanel(() => {
    void togglePanel(!panelVisible);
  });
  window.overlayApi.onCopyCurrent(() => {
    void copyCurrentText();
  });

  window.addEventListener('keydown', (event) => {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const hotkey = event.shiftKey && event.key.toLowerCase() === 'o' && (isMac ? event.metaKey : event.ctrlKey);
    if (hotkey) {
      event.preventDefault();
      void togglePanel(!panelVisible);
    }
    if (event.key === 'Escape' && panelVisible) {
      event.preventDefault();
      void togglePanel(false);
    }
    const copyHotkey = event.shiftKey && event.key.toLowerCase() === 'c' && (isMac ? event.metaKey : event.ctrlKey);
    if (copyHotkey) {
      event.preventDefault();
      void copyCurrentText();
    }
  });
}

// window.pickerApi.onStartDrag((payload) => {
//   mode = "drag";
//   originX = payload?.originX ?? 0;
//   originY = payload?.originY ?? 0;
//   document.body.classList.add("drag-mode");
// });

// document.addEventListener("mousedown", (event: MouseEvent) => {
//   if (mode !== "drag" || event.button !== 0) return;
//   dragging = true;
//   startX = event.clientX;
//   startY = event.clientY;
// });

// document.addEventListener("mousemove", (event: MouseEvent) => {
//   if (!dragging) return;
// });

// document.addEventListener("mouseup", async (event: MouseEvent) => {
//   if (!dragging) return;
//   dragging = false;
// });

(async () => {
  gameId = await window.overlayApi.getGameId();
  settings = await window.overlayApi.getSettings();
  setStyle(settings);
  installPanelEvents();
  show('Overlay ready', `Profile: ${gameId}`, 5000);
  connect();
})();
