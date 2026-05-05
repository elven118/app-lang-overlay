type OverlaySettings = {
  anchor: 'top' | 'bottom';
  offsetX: number;
  offsetY: number;
  maxWidth: number;
  fontSize: number;
  lineGap: number;
  textColor: string;
  translateColor: string;
  outlineColor: string;
  background: string;
  autoHideMs: number;
  dedupeWindowMs: number;
  clickthrough: boolean;
  ocrLang: string;
};

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

const sourceEl = document.getElementById('source') as HTMLDivElement;
const translatedEl = document.getElementById('translated') as HTMLDivElement;
const box = document.getElementById('subtitle-box') as HTMLDivElement;
const root = document.getElementById('root') as HTMLDivElement;
const panel = document.getElementById('settings-panel') as HTMLDivElement;

const anchorSelect = document.getElementById('setting-anchor') as HTMLSelectElement;
const offsetXInput = document.getElementById('setting-offset-x') as HTMLInputElement;
const offsetYInput = document.getElementById('setting-offset-y') as HTMLInputElement;
const maxWidthInput = document.getElementById('setting-max-width') as HTMLInputElement;
const fontSizeInput = document.getElementById('setting-font-size') as HTMLInputElement;
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
const dedupeSeen = new Map<string, number>();

function setStyle(nextSettings: OverlaySettings): void {
  document.documentElement.style.setProperty('--font-size', `${nextSettings.fontSize}px`);
  document.documentElement.style.setProperty('--line-gap', `${nextSettings.lineGap}px`);
  document.documentElement.style.setProperty('--text-color', nextSettings.textColor);
  document.documentElement.style.setProperty('--translate-color', nextSettings.translateColor);
  document.documentElement.style.setProperty('--outline-color', nextSettings.outlineColor);
  document.documentElement.style.setProperty('--bg', nextSettings.background);
  document.documentElement.style.setProperty('--max-width', `${nextSettings.maxWidth}px`);
  document.documentElement.style.setProperty('--offset-x', `${nextSettings.offsetX}px`);
  document.documentElement.style.setProperty('--offset-y', `${nextSettings.offsetY}px`);
  root.classList.remove('anchor-top', 'anchor-bottom');
  root.classList.add(nextSettings.anchor === 'top' ? 'anchor-top' : 'anchor-bottom');
}

function show(sourceText: string, translatedText: string | null, hideAfterMs: number | undefined): void {
  sourceEl.textContent = sourceText;
  translatedEl.textContent = translatedText || '';
  box.classList.remove('hidden');
  box.classList.add('visible');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hide(), hideAfterMs || settings.autoHideMs);
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
  anchorSelect.value = settings.anchor;
  offsetXInput.value = String(settings.offsetX);
  offsetYInput.value = String(settings.offsetY);
  maxWidthInput.value = String(settings.maxWidth);
  fontSizeInput.value = String(settings.fontSize);
  textColorInput.value = settings.textColor.startsWith('#') ? settings.textColor : '#ffffff';
  translateColorInput.value = settings.translateColor.startsWith('#') ? settings.translateColor : '#ffd166';
  const bg = parseBackground(settings.background);
  backgroundColorInput.value = bg.colorHex;
  backgroundAlphaInput.value = String(bg.alphaPercent);
  autoHideInput.value = String(settings.autoHideMs);
  dedupeInput.value = String(settings.dedupeWindowMs);
  ocrLangInput.value = settings.ocrLang || 'eng';
  clickthroughInput.checked = settings.clickthrough;
}

function parsePanelSettings(): OverlaySettings {
  return {
    ...settings,
    anchor: anchorSelect.value === 'top' ? 'top' : 'bottom',
    offsetX: Number(offsetXInput.value || settings.offsetX),
    offsetY: Number(offsetYInput.value || settings.offsetY),
    maxWidth: Number(maxWidthInput.value || settings.maxWidth),
    fontSize: Number(fontSizeInput.value || settings.fontSize),
    textColor: textColorInput.value || settings.textColor,
    translateColor: translateColorInput.value || settings.translateColor,
    background: composeBackground(),
    autoHideMs: Number(autoHideInput.value || settings.autoHideMs),
    dedupeWindowMs: Number(dedupeInput.value || settings.dedupeWindowMs),
    ocrLang: ocrLangInput.value || settings.ocrLang || 'eng',
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
  panel.classList.toggle('visible', panelVisible);
  panel.classList.toggle('hidden', !panelVisible);
  if (panelVisible) {
    syncPanelFromSettings();
    await window.overlayApi.setClickthrough(false);
    show('Overlay settings', 'Press Cmd/Ctrl+Shift+O to close', 4000);
  } else {
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

  anchorSelect.addEventListener('change', persist);
  offsetXInput.addEventListener('change', persist);
  offsetYInput.addEventListener('change', persist);
  maxWidthInput.addEventListener('change', persist);
  fontSizeInput.addEventListener('change', persist);
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
  });
}

(async () => {
  gameId = await window.overlayApi.getGameId();
  settings = await window.overlayApi.getSettings();
  setStyle(settings);
  installPanelEvents();
  show('Overlay ready', `Profile: ${gameId}`, 2200);
  connect();
})();
