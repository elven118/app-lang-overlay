import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  Display,
  globalShortcut,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  screen,
} from "electron";
import type { CaptureRegion, OverlaySettings } from "./shared/types";

interface SelectionWindow extends BrowserWindow {
  display?: Display;
  displayIndex?: number;
}

const DEFAULT_SETTINGS: OverlaySettings = {
  placementMode: "free",
  placement: {
    above: { xShift: 0, gapY: 0 },
    free: { x: 24, y: 24 },
  },
  showSource: true,
  width: 600,
  sourceFontSize: 12,
  translatedFontSize: 12,
  lineGap: 10,
  textColor: "#ffffff",
  translateColor: "#ffd166",
  background: "rgba(0,0,0,0.35)",
  autoHideMs: 5000,
  clickthrough: true,
  ocrLang: "en",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeCaptureRegion(value: unknown): CaptureRegion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<CaptureRegion>;
  const left = asFiniteNumber(raw.left, NaN);
  const top = asFiniteNumber(raw.top, NaN);
  const width = asFiniteNumber(raw.width, NaN);
  const height = asFiniteNumber(raw.height, NaN);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return undefined;
  }
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function createDefaultPlacement(
  width: number,
  captureRegion: CaptureRegion | undefined,
): OverlaySettings["placement"] {
  const captureCenterX = captureRegion ? captureRegion.left + captureRegion.width / 2 : width / 2;
  const freeX = Math.max(0, Math.round(captureCenterX - width / 2));
  const freeY = captureRegion ? Math.max(0, Math.round(captureRegion.top + captureRegion.height)) : 24;
  return {
    above: { xShift: 0, gapY: 0 },
    free: { x: freeX, y: freeY },
  };
}

function normalizeOverlaySettings(
  rawValue: unknown,
  displayBounds: { width: number; height: number },
): OverlaySettings {
  const raw = ((rawValue || {}) as Partial<OverlaySettings>) || {};
  const captureRegion = normalizeCaptureRegion(raw.captureRegion);
  const width = Math.max(1, Math.round(asFiniteNumber(raw.width, captureRegion?.width ?? DEFAULT_SETTINGS.width)));

  const defaults = createDefaultPlacement(width, captureRegion);
  const rawPlacement = (raw.placement || {}) as Partial<OverlaySettings["placement"]>;
  const rawAbove = (rawPlacement.above || {}) as Partial<OverlaySettings["placement"]["above"]>;
  const rawFree = (rawPlacement.free || {}) as Partial<OverlaySettings["placement"]["free"]>;

  const placement: OverlaySettings["placement"] = {
    above: {
      xShift: Math.round(asFiniteNumber(rawAbove.xShift, defaults.above.xShift)),
      gapY: Math.max(0, Math.round(asFiniteNumber(rawAbove.gapY, defaults.above.gapY))),
    },
    free: {
      x: Math.round(asFiniteNumber(rawFree.x, defaults.free.x)),
      y: Math.round(asFiniteNumber(rawFree.y, defaults.free.y)),
    },
  };

  const maxFreeX = Math.max(0, displayBounds.width - width);
  placement.free.x = clamp(placement.free.x, 0, maxFreeX);
  placement.free.y = clamp(placement.free.y, 0, Math.max(0, displayBounds.height));

  const placementMode = raw.placementMode === "above" || raw.placementMode === "free"
    ? raw.placementMode
    : DEFAULT_SETTINGS.placementMode;

  const background = typeof raw.background === "string" ? raw.background : DEFAULT_SETTINGS.background;
  const textColor = typeof raw.textColor === "string" ? raw.textColor : DEFAULT_SETTINGS.textColor;
  const translateColor = typeof raw.translateColor === "string" ? raw.translateColor : DEFAULT_SETTINGS.translateColor;

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    placementMode,
    placement,
    width,
    sourceFontSize: Math.max(0, Math.round(asFiniteNumber(raw.sourceFontSize, DEFAULT_SETTINGS.sourceFontSize))),
    translatedFontSize: Math.max(
      0,
      Math.round(asFiniteNumber(raw.translatedFontSize, DEFAULT_SETTINGS.translatedFontSize)),
    ),
    lineGap: Math.max(0, Math.round(asFiniteNumber(raw.lineGap, DEFAULT_SETTINGS.lineGap))),
    autoHideMs: Math.max(300, Math.round(asFiniteNumber(raw.autoHideMs, DEFAULT_SETTINGS.autoHideMs))),
    clickthrough: typeof raw.clickthrough === "boolean" ? raw.clickthrough : DEFAULT_SETTINGS.clickthrough,
    ocrLang: String(raw.ocrLang || DEFAULT_SETTINGS.ocrLang),
    background,
    textColor,
    translateColor,
    captureRegion,
  };
}

const gameId = process.env.GAME_ID || "demo";
const wsUrl = process.env.OVERLAY_WS_URL || "ws://127.0.0.1:8765";
const repoRoot = path.resolve(__dirname, "../..");

let overlayWindow: BrowserWindow | null = null;
let controlWindow: BrowserWindow | null = null;
let selectionWindows: SelectionWindow[] = [];
let appMenu: Menu | null = null;
let quitting = false;

function getTargetDisplay(profile: Record<string, unknown>): Display {
  const displayId = profile.capture_display_id;
  if (typeof displayId === "number") {
    const byId = screen.getAllDisplays().find((d) => d.id === displayId);
    if (byId) return byId;
  }

  const region = profile.capture_region as Partial<CaptureRegion> | undefined;
  if (
    region &&
    typeof region.left === "number" &&
    typeof region.top === "number" &&
    typeof region.width === "number" &&
    typeof region.height === "number"
  ) {
    const center = {
      x: Math.round(region.left + region.width / 2),
      y: Math.round(region.top + region.height / 2),
    };
    return screen.getDisplayNearestPoint(center);
  }

  return screen.getPrimaryDisplay();
}

function deriveOverlayCaptureRegion(profile: Record<string, unknown>, targetDisplay: Display): CaptureRegion | undefined {
  const region = profile.capture_region as Partial<CaptureRegion> | undefined;
  if (
    !region ||
    typeof region.left !== "number" ||
    typeof region.top !== "number" ||
    typeof region.width !== "number" ||
    typeof region.height !== "number" ||
    region.width <= 0 ||
    region.height <= 0
  ) {
    return undefined;
  }

  const scaleFactor = process.platform === "win32" ? (targetDisplay.scaleFactor || 1) : 1;
  const toDip = (value: number): number => value / scaleFactor;
  const bounds = targetDisplay.bounds;
  const origin = profile.capture_window_origin as { x?: unknown; y?: unknown } | undefined;
  const originX = typeof origin?.x === "number" && Number.isFinite(origin.x) ? origin.x : bounds.x;
  const originY = typeof origin?.y === "number" && Number.isFinite(origin.y) ? origin.y : bounds.y;

  return {
    left: Math.round(toDip(region.left) - originX),
    top: Math.round(toDip(region.top) - originY),
    width: Math.max(1, Math.round(toDip(region.width))),
    height: Math.max(1, Math.round(toDip(region.height))),
  };
}

function profilePathFor(game: string): string {
  return path.join(repoRoot, "data", "profiles", `${game}.json`);
}

function loadProfile(game: string): Record<string, unknown> {
  const profilePath = profilePathFor(game);
  if (!fs.existsSync(profilePath)) {
    return { game_id: game };
  }
  const raw = fs.readFileSync(profilePath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function saveProfile(game: string, profile: Record<string, unknown>): void {
  const profilePath = profilePathFor(game);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n", "utf-8");
}

function ensureProfileExists(game: string): Record<string, unknown> {
  const profile = loadProfile(game);
  if (typeof profile.game_id !== "string") {
    profile.game_id = game;
  }
  const targetDisplay = getTargetDisplay(profile);
  let normalized = normalizeOverlaySettings(profile.overlay_settings, targetDisplay.bounds);
  if (!normalized.captureRegion) {
    const derivedRegion = deriveOverlayCaptureRegion(profile, targetDisplay);
    if (derivedRegion) {
      normalized = normalizeOverlaySettings(
        { ...normalized, captureRegion: derivedRegion, width: derivedRegion.width },
        targetDisplay.bounds,
      );
    }
  }
  profile.overlay_settings = normalized;
  saveProfile(game, profile);
  return profile;
}

function hasCaptureRegion(game: string): boolean {
  const profile = loadProfile(game);
  const region = profile.capture_region as Partial<CaptureRegion> | undefined;
  return Boolean(
    region &&
      typeof region.left === "number" &&
      typeof region.top === "number" &&
      typeof region.width === "number" &&
      typeof region.height === "number" &&
      region.width > 0 &&
      region.height > 0,
  );
}

function getOverlaySettings(game: string): OverlaySettings {
  const profile = loadProfile(game);
  const targetDisplay = getTargetDisplay(profile);
  let normalized = normalizeOverlaySettings(profile.overlay_settings, targetDisplay.bounds);
  if (!normalized.captureRegion) {
    const derivedRegion = deriveOverlayCaptureRegion(profile, targetDisplay);
    if (derivedRegion) {
      normalized = normalizeOverlaySettings(
        { ...normalized, captureRegion: derivedRegion, width: derivedRegion.width },
        targetDisplay.bounds,
      );
    }
  }
  profile.overlay_settings = normalized;
  saveProfile(game, profile);
  return normalized;
}

function saveOverlaySettings(game: string, settings: OverlaySettings): OverlaySettings {
  const profile = loadProfile(game);
  const targetDisplay = getTargetDisplay(profile);
  const normalized = normalizeOverlaySettings(settings, targetDisplay.bounds);
  profile.overlay_settings = normalized;
  saveProfile(game, profile);
  return normalized;
}

function saveCaptureRegion(
  game: string,
  region: CaptureRegion,
  pickerWindowBounds?: { x: number; y: number },
): void {
  const profile = loadProfile(game);
  const targetDisplay = screen.getDisplayNearestPoint({
    x: Math.round(region.left + region.width / 2),
    y: Math.round(region.top + region.height / 2),
  });
  const scaleFactor = process.platform === "win32" ? (targetDisplay.scaleFactor || 1) : 1;
  const toDip = (value: number): number => value / scaleFactor;

  profile.capture_region = region;
  profile.capture_display_id = targetDisplay.id;

  const displayBounds = targetDisplay.bounds;
  const originX = pickerWindowBounds?.x ?? displayBounds.x;
  const originY = pickerWindowBounds?.y ?? displayBounds.y;
  profile.capture_window_origin = { x: Math.round(originX), y: Math.round(originY) };

  const localLeftDip = toDip(region.left) - originX;
  const localTopDip = toDip(region.top) - originY;
  const widthDip = toDip(region.width);
  const heightDip = toDip(region.height);
  const captureRegion: CaptureRegion = {
    left: Math.round(localLeftDip),
    top: Math.round(localTopDip),
    width: Math.max(1, Math.round(widthDip)),
    height: Math.max(1, Math.round(heightDip)),
  };

  const existing = normalizeOverlaySettings(profile.overlay_settings, displayBounds);
  profile.overlay_settings = normalizeOverlaySettings({
    ...existing,
    placementMode: existing.placementMode || "free",
    width: captureRegion.width,
    captureRegion,
    placement: {
      ...existing.placement,
      free: {
        ...existing.placement.free,
        x: Math.round(captureRegion.left),
        y: Math.round(captureRegion.top + captureRegion.height),
      },
    },
  }, displayBounds);

  saveProfile(game, profile);
}

function applyClickthrough(enabled: boolean): boolean {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }
  overlayWindow.setIgnoreMouseEvents(enabled, { forward: true });
  return enabled;
}

function createOverlayWindow(): BrowserWindow {
  const profile = loadProfile(gameId);
  const targetDisplay = getTargetDisplay(profile);
  const bounds = targetDisplay.bounds;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload/index.js"),
    },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "renderer/overlay/index.html"), {
    query: { ws: wsUrl },
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      event.preventDefault();
      win.webContents.send("overlay:close-panel");
    }
  });

  const settings = getOverlaySettings(gameId);
  win.setIgnoreMouseEvents(settings.clickthrough, { forward: true });

  return win;
}

function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 320,
    minWidth: 380,
    minHeight: 280,
    title: "App Lang Overlay",
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload/index.js"),
    },
  });

  win.loadFile(path.join(__dirname, "renderer/control/index.html"));

  if (appMenu && process.platform !== "darwin") {
    win.setMenu(appMenu);
    win.setMenuBarVisibility(true);
  }

  win.on("close", (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    if (process.platform === "darwin") {
      win.hide();
    } else {
      win.minimize();
    }
  });

  return win;
}

function showControlWindow(): void {
  if (!controlWindow || controlWindow.isDestroyed()) {
    controlWindow = createControlWindow();
  }
  if (controlWindow.isMinimized()) {
    controlWindow.restore();
  }
  controlWindow.show();
  controlWindow.focus();
}

function hideControlWindow(): void {
  if (!controlWindow || controlWindow.isDestroyed()) {
    return;
  }
  controlWindow.hide();
}

function toggleControlWindow(): void {
  if (!controlWindow || controlWindow.isDestroyed()) {
    controlWindow = createControlWindow();
    showControlWindow();
    return;
  }
  if (!controlWindow.isVisible() || controlWindow.isMinimized()) {
    showControlWindow();
    return;
  }
  hideControlWindow();
}

function toggleOverlayPanel(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.focus();
    overlayWindow.webContents.send("overlay:toggle-panel");
  }
}

function refreshOverlayWindowForProfile(): void {
  const profile = loadProfile(gameId);
  const targetDisplay = getTargetDisplay(profile);
  const bounds = targetDisplay.bounds;

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = createOverlayWindow();
    return;
  }

  overlayWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
  overlayWindow.webContents.reloadIgnoringCache();
}

async function openRegionPickerWindows() {
  closeRegionPickerWindows();

  const displays = screen.getAllDisplays();

  selectionWindows = displays.map((display, index) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      alwaysOnTop: true,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: true,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload/index.js"),
      },
    }) as SelectionWindow;

    win.display = display;
    win.displayIndex = index;

    win.loadFile(path.join(__dirname, "renderer/picker/index.html"));

    if (displays.length === 1) {
      win.webContents.once("did-finish-load", () => {
        win.webContents.send("picker:start-drag", {
          originX: display.bounds.x,
          originY: display.bounds.y,
          captureScaleFactor: process.platform === "win32" ? (display.scaleFactor || 1) : 1,
        });
      });
    }

    win.webContents.on("before-input-event", (_event, input) => {
      if (input.key === "Escape") {
        closeRegionPickerWindows();
      }
    });

    win.on("closed", () => {
      selectionWindows = selectionWindows.filter((w) => w !== win);
    });

    return win;
  });
}

function closeRegionPickerWindows(): void {
  selectionWindows.forEach((win) => {
    if (!win.isDestroyed()) {
      win.close();
    }
  });
  selectionWindows = [];
}

ipcMain.handle("overlay:get-settings", () => getOverlaySettings(gameId));

ipcMain.handle("overlay:save-settings", (_event, payload: OverlaySettings) => {
  const saved = saveOverlaySettings(gameId, payload);
  applyClickthrough(saved.clickthrough);
  return saved;
});

ipcMain.handle("overlay:set-clickthrough", (_event, enabled: boolean) => {
  const current = getOverlaySettings(gameId);
  const saved = saveOverlaySettings(gameId, { ...current, clickthrough: Boolean(enabled) });
  return applyClickthrough(saved.clickthrough);
});

ipcMain.handle("overlay:get-game-id", () => gameId);
ipcMain.handle("overlay:copy-text", (_event, text: string) => {
  const safe = String(text || "");
  if (!safe.trim()) return false;
  clipboard.writeText(safe);
  return true;
});

ipcMain.handle("overlay:pick-region", async () => {
  await openRegionPickerWindows();
  return { status: "started" };
});
ipcMain.handle("control:toggle-window", () => {
  toggleControlWindow();
  return Boolean(controlWindow && !controlWindow.isDestroyed() && controlWindow.isVisible());
});
ipcMain.handle("control:show-window", () => {
  showControlWindow();
  return true;
});
ipcMain.handle("control:hide-window", () => {
  hideControlWindow();
  return false;
});
ipcMain.handle("control:get-visible", () => {
  return Boolean(controlWindow && !controlWindow.isDestroyed() && controlWindow.isVisible());
});
ipcMain.handle("control:toggle-overlay-panel", () => {
  toggleOverlayPanel();
  return true;
});
ipcMain.handle("control:toggle-clickthrough", () => {
  const settings = getOverlaySettings(gameId);
  const next = !settings.clickthrough;
  saveOverlaySettings(gameId, { ...settings, clickthrough: next });
  applyClickthrough(next);
  return next;
});

ipcMain.on("picker:selected", (event) => {
  const selectedWindow = BrowserWindow.fromWebContents(event.sender) as SelectionWindow | null;
  if (!selectedWindow || selectedWindow.isDestroyed()) {
    return;
  }

  selectionWindows.forEach((win) => {
    if (win !== selectedWindow && !win.isDestroyed()) {
      win.close();
    }
  });

  selectionWindows = [selectedWindow];
  selectedWindow.focus();
  const bounds = selectedWindow.getBounds();
  selectedWindow.webContents.send("picker:start-drag", {
    originX: bounds.x,
    originY: bounds.y,
    captureScaleFactor: process.platform === "win32" ? (selectedWindow.display?.scaleFactor ?? 1) : 1,
  });
});

ipcMain.handle("picker:submit", (event, region: CaptureRegion) => {
  if (region.width <= 0 || region.height <= 0) {
    return { status: "invalid" };
  }

  const selectedWindow = BrowserWindow.fromWebContents(event.sender) as SelectionWindow | null;
  const pickerBounds = selectedWindow && !selectedWindow.isDestroyed() ? selectedWindow.getBounds() : undefined;

  saveCaptureRegion(gameId, region, pickerBounds);
  refreshOverlayWindowForProfile();
  closeRegionPickerWindows();

  return {
    status: "ok",
    game_id: gameId,
    capture_region: region,
    profile_path: profilePathFor(gameId),
  };
});

ipcMain.handle("picker:cancel", () => {
  closeRegionPickerWindows();
  return { status: "cancelled" };
});

const template: MenuItemConstructorOptions[] = [
  {
    label: "Overlay",
    submenu: [
      {
        label: "Pick Capture Region",
        click: () => {
          if (selectionWindows.length === 0) {
            void openRegionPickerWindows();
          }
        },
      },
      {
        label: "Toggle Clickthrough",
        click: () => {
          const settings = getOverlaySettings(gameId);
          const next = !settings.clickthrough;
          saveOverlaySettings(gameId, { ...settings, clickthrough: next });
          applyClickthrough(next);
        },
      },
      {
        label: "Toggle Settings Panel",
        click: () => {
          toggleOverlayPanel();
        },
      },
      { type: "separator" },
      {
        role: "quit",
        label: "Quit",
      },
    ],
  },
];

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    app.dock?.show();
  }

  ensureProfileExists(gameId);

  globalShortcut.register("CommandOrControl+Shift+R", () => {
    openRegionPickerWindows().catch((err) => {
      console.error("[overlay] picker failed:", err);
    });
  });
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    toggleOverlayPanel();
  });
  globalShortcut.register("CommandOrControl+Shift+C", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("overlay:copy-current");
    }
  });

  appMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(appMenu);

  overlayWindow = createOverlayWindow();
  controlWindow = createControlWindow();
  showControlWindow();

  if (!hasCaptureRegion(gameId)) {
    openRegionPickerWindows().catch((err) => {
      console.error("[overlay] initial picker failed:", err);
    });
  }
});

app.on("activate", () => {
  showControlWindow();
});

app.on("will-quit", () => {
  quitting = true;
  globalShortcut.unregisterAll();
});
