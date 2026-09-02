type SubtitleEvent = {
  type: "subtitle";
  profile: string;
  timestamp: number;
  source_text: string;
  translated_text: string | null;
  lang_src: string;
  lang_dst: string;
  dedupe_key: string;
  hide_after_ms?: number;
};

type ClearEvent = {
  type: "clear";
  profile: string;
  timestamp: number;
  reason?: string;
};

type HealthEvent = {
  type: "health";
  timestamp: number;
  status?: string;
};

type OverlayEvent = SubtitleEvent | ClearEvent | HealthEvent;

import type { CaptureRegion, OverlaySettings } from "../../shared/types";

const sourceEl = document.getElementById("source") as HTMLDivElement;
const translatedEl = document.getElementById("translated") as HTMLDivElement;
const box = document.getElementById("subtitle-box") as HTMLDivElement;
const root = document.getElementById("root") as HTMLDivElement;
const panel = document.getElementById("settings-panel") as HTMLDivElement;
const positionInput = document.getElementById(
  "setting-position",
) as HTMLSelectElement;
const widthInput = document.getElementById("setting-width") as HTMLInputElement;
const showSourceInput = document.getElementById(
  "setting-show-source",
) as HTMLInputElement;
const sourceFontSizeInput = document.getElementById(
  "setting-source-font-size",
) as HTMLInputElement;
const translatedFontSizeInput = document.getElementById(
  "setting-translated-font-size",
) as HTMLInputElement;
const textColorInput = document.getElementById(
  "setting-text-color",
) as HTMLInputElement;
const translateColorInput = document.getElementById(
  "setting-translate-color",
) as HTMLInputElement;
const backgroundColorInput = document.getElementById(
  "setting-background-color",
) as HTMLInputElement;
const backgroundAlphaInput = document.getElementById(
  "setting-background-alpha",
) as HTMLInputElement;
const autoHideInput = document.getElementById(
  "setting-autohide",
) as HTMLInputElement;
const ocrLangInput = document.getElementById(
  "setting-ocr-lang",
) as HTMLSelectElement;
const clickthroughInput = document.getElementById(
  "setting-clickthrough",
) as HTMLInputElement;

let ws: WebSocket | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let settings: OverlaySettings;
let gameId = "demo";
let panelVisible = false;
let latestSourceText = "";
let latestTranslatedText = "";

type DragState = {
  startMouseX: number;
  startMouseY: number;
  startX: number;
  startY: number;
};

let dragState: DragState | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getCaptureRegion(nextSettings: OverlaySettings): CaptureRegion | null {
  const region = nextSettings.captureRegion;
  if (!region || region.width <= 0 || region.height <= 0) return null;
  return region;
}

function getRootSize(): { width: number; height: number } {
  const rect = root.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || settings.width || 1));
  const height = Math.max(1, Math.round(rect.height || 1));
  return { width, height };
}

function applyPlacement(nextSettings: OverlaySettings): void {
  const region = getCaptureRegion(nextSettings);
  const { width: boxWidth, height: boxHeight } = getRootSize();
  const maxX = Math.max(0, window.innerWidth - boxWidth);
  const maxY = Math.max(0, window.innerHeight - boxHeight);

  let nextX = 0;
  let nextY = 0;

  if (nextSettings.placementMode === 'above' && region) {
    const captureCenterX = region.left + region.width / 2;
    nextX = captureCenterX - boxWidth / 2 + nextSettings.placement.above.xShift;
    nextX = clamp(Math.round(nextX), 0, maxX);

    const aboveY = region.top - boxHeight - nextSettings.placement.above.gapY;
    const maxAllowedY = region.top - boxHeight;
    nextY = Math.round(Math.min(aboveY, maxAllowedY));
  } else if (nextSettings.placementMode === 'free' || !region) {
    nextX = clamp(Math.round(nextSettings.placement.free.x), 0, maxX);
    nextY = clamp(Math.round(nextSettings.placement.free.y), 0, maxY);
  } else if (region) {
    const captureCenterX = region.left + region.width / 2;
    nextX = clamp(Math.round(captureCenterX - boxWidth / 2), 0, maxX);
    nextY = Math.round(region.top - boxHeight);
  }

  root.style.left = `${nextX}px`;
  root.style.top = `${nextY}px`;
}

function setStyle(nextSettings: OverlaySettings): void {
  document.documentElement.style.setProperty(
    "--source-font-size",
    `${nextSettings.sourceFontSize}px`,
  );
  document.documentElement.style.setProperty(
    "--translated-font-size",
    `${nextSettings.translatedFontSize}px`,
  );
  document.documentElement.style.setProperty(
    "--line-gap",
    `${nextSettings.lineGap}px`,
  );
  document.documentElement.style.setProperty(
    "--text-color",
    nextSettings.textColor,
  );
  document.documentElement.style.setProperty(
    "--translate-color",
    nextSettings.translateColor,
  );
  document.documentElement.style.setProperty("--bg", nextSettings.background);
  document.documentElement.style.setProperty(
    "--width",
    `${nextSettings.width}px`,
  );
  document.documentElement.style.setProperty(
    "--show-source",
    nextSettings.showSource ? "block" : "none",
  );

  box.classList.toggle("draggable", panelVisible);
}

function show(
  sourceText: string,
  translatedText: string | null,
  hideAfterMs: number | undefined,
): void {
  latestSourceText = sourceText || "";
  latestTranslatedText = translatedText || "";
  if (sourceEl) sourceEl.textContent = sourceText;
  translatedEl.textContent = translatedText || "";
  box.classList.remove("hidden");
  box.classList.add("visible");
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hide(), hideAfterMs || settings.autoHideMs);
}

async function copyCurrentText(): Promise<void> {
  const text = (latestTranslatedText || latestSourceText || "").trim();
  if (!text) {
    show("Nothing to copy", "", 900);
    return;
  }
  const ok = await window.overlayApi.copyText(text);
  if (ok) {
    show("Copied to clipboard", text, 1200);
  }
}

function hide(): void {
  box.classList.remove("visible");
  box.classList.add("hidden");
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.trim().replace("#", "");
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : normalized;
  const safe = /^[0-9a-fA-F]{6}$/.test(full) ? full : "000000";
  return {
    r: parseInt(safe.slice(0, 2), 16),
    g: parseInt(safe.slice(2, 4), 16),
    b: parseInt(safe.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) =>
    clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function parseBackground(value: string): {
  colorHex: string;
  alphaPercent: number;
} {
  const rgbaMatch = value.match(/rgba?\(([^)]+)\)/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(",").map((p) => p.trim());
    const r = Number(parts[0] || "0");
    const g = Number(parts[1] || "0");
    const b = Number(parts[2] || "0");
    const a = parts[3] === undefined ? 1 : Number(parts[3]);
    return {
      colorHex: rgbToHex(r, g, b),
      alphaPercent: clamp(
        Math.round((Number.isFinite(a) ? a : 1) * 100),
        0,
        100,
      ),
    };
  }
  if (value.startsWith("#")) {
    const rgb = hexToRgb(value);
    return { colorHex: rgbToHex(rgb.r, rgb.g, rgb.b), alphaPercent: 100 };
  }
  return { colorHex: "#000000", alphaPercent: 35 };
}

function composeBackground(): string {
  const { r, g, b } = hexToRgb(backgroundColorInput.value);
  const alpha = clamp(Number(backgroundAlphaInput.value || "35"), 0, 100) / 100;
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

function syncPanelFromSettings(): void {}

function parsePanelSettings(): OverlaySettings {
  return {
    ...settings,
  };
}

async function persistSettings(next: OverlaySettings): Promise<void> {
  settings = await window.overlayApi.saveSettings(next);
  setStyle(settings);
  syncPanelFromSettings();
  if (panelVisible) {
    await window.overlayApi.setClickthrough(false);
  }
}

async function persistFromPanel(): Promise<void> {
  const next = parsePanelSettings();
  await persistSettings(next);
}

async function togglePanel(nextVisible: boolean): Promise<void> {
  panelVisible = nextVisible;
  if (panelVisible) {
    await window.overlayApi.setClickthrough(false);

    syncPanelFromSettings();
    panel.classList.remove("hidden");
    box.classList.add("draggable");

    show("Overlay settings", "Press Cmd/Ctrl+Shift+P to close", 4000);
  } else {
    panel.classList.add("hidden");
    box.classList.remove("draggable");
    box.classList.remove("dragging");
    dragState = null;
    await window.overlayApi.setClickthrough(settings.clickthrough);
  }
}

function startDrag(event: MouseEvent): void {
  if (!panelVisible || event.button !== 0) return;
  event.preventDefault();

  dragState = {
    startMouseX: event.clientX,
    startMouseY: event.clientY,
    startX: settings.placement.free.x,
    startY: settings.placement.free.y,
  };

  box.classList.add("dragging");
}

function onDragMove(event: MouseEvent): void {
  if (!dragState) return;

  const dx = event.clientX - dragState.startMouseX;
  const dy = event.clientY - dragState.startMouseY;

  const { width: boxWidth, height: boxHeight } = getRootSize();
  const maxX = Math.max(0, window.innerWidth - boxWidth);
  const maxY = Math.max(0, window.innerHeight - boxHeight);
  const x = clamp(Math.round(dragState.startX + dx), 0, maxX);
  const y = clamp(Math.round(dragState.startY + dy), 0, maxY);
  settings = {
    ...settings,
    placement: {
      ...settings.placement,
      free: { x, y },
    },
  };

  setStyle(settings);
}

function endDrag(): void {
  if (!dragState) return;
  dragState = null;
  box.classList.remove("dragging");
  void persistSettings(settings);
}

function connect(): void {
  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get("ws") || "ws://127.0.0.1:8765";
  ws = new WebSocket(wsUrl);

  ws.onmessage = (event: MessageEvent<string>) => {
    let payload: OverlayEvent;
    try {
      payload = JSON.parse(event.data) as OverlayEvent;
    } catch {
      return;
    }

    if (payload.type === "subtitle") {
      if (payload.profile !== gameId) return;
      show(payload.source_text, payload.translated_text, payload.hide_after_ms);
    } else if (payload.type === "clear") {
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

  positionInput.addEventListener("change", persist);
  widthInput.addEventListener("change", persist);
  showSourceInput.addEventListener("change", persist);
  sourceFontSizeInput.addEventListener("change", persist);
  translatedFontSizeInput.addEventListener("change", persist);
  textColorInput.addEventListener("input", persist);
  translateColorInput.addEventListener("input", persist);
  backgroundColorInput.addEventListener("input", persist);
  backgroundAlphaInput.addEventListener("input", persist);
  autoHideInput.addEventListener("change", persist);
  ocrLangInput.addEventListener("change", persist);
  clickthroughInput.addEventListener("change", persist);

  window.overlayApi.onTogglePanel(() => {
    void togglePanel(!panelVisible);
  });
  window.overlayApi.onCopyCurrent(() => {
    void copyCurrentText();
  });

  box.addEventListener("mousedown", startDrag);
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", endDrag);
  window.addEventListener("resize", () => applyPlacement(settings));

  const resizeObserver = new ResizeObserver(() => {
    applyPlacement(settings);
  });
  resizeObserver.observe(box);

  window.addEventListener("keydown", (event) => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const hotkey =
      event.shiftKey &&
      event.key.toLowerCase() === "p" &&
      (isMac ? event.metaKey : event.ctrlKey);
    if (hotkey) {
      event.preventDefault();
      void togglePanel(!panelVisible);
    }
    if (event.key === "Escape" && panelVisible) {
      event.preventDefault();
      void togglePanel(false);
    }
    const copyHotkey =
      event.shiftKey &&
      event.key.toLowerCase() === "c" &&
      (isMac ? event.metaKey : event.ctrlKey);
    if (copyHotkey) {
      event.preventDefault();
      void copyCurrentText();
    }
  });
}

(async () => {
  gameId = await window.overlayApi.getGameId();
  settings = await window.overlayApi.getSettings();
  setStyle(settings);
  installPanelEvents();
  show("Overlay ready", `Profile: ${gameId}`, 5000);
  connect();
})();
