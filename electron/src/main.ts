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
  offsetX: 0,
  offsetY: 0,
  showSource: true,
  position: "bottom",
  width: 600,
  sourceFontSize: 12,
  translatedFontSize: 12,
  lineGap: 10,
  textColor: "#ffffff",
  translateColor: "#ffd166",
  background: "rgba(0,0,0,0.35)",
  autoHideMs: 5000,
  dedupeWindowMs: 1200,
  clickthrough: true,
  ocrLang: "en",
};

const gameId = process.env.GAME_ID || "demo";
const wsUrl = process.env.OVERLAY_WS_URL || "ws://127.0.0.1:8765";
const repoRoot = path.resolve(__dirname, "../..");

let overlayWindow: BrowserWindow | null = null;
let selectionWindows: SelectionWindow[] = [];

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
  if (profile.overlay_settings === undefined) {
    profile.overlay_settings = { ...DEFAULT_SETTINGS };
  }
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
  const saved = (profile.overlay_settings || {}) as Partial<OverlaySettings>;
  return { ...DEFAULT_SETTINGS, ...saved };
}

function saveOverlaySettings(game: string, settings: OverlaySettings): OverlaySettings {
  const normalized: OverlaySettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    width: Math.round(settings.width),
    sourceFontSize: Math.max(0, Math.round(settings.sourceFontSize)),
    translatedFontSize: Math.max(0, Math.round(settings.translatedFontSize)),
    lineGap: Math.max(0, Math.round(settings.lineGap)),
    autoHideMs: Math.max(300, Math.round(settings.autoHideMs)),
    dedupeWindowMs: Math.max(0, Math.round(settings.dedupeWindowMs)),
    clickthrough: Boolean(settings.clickthrough),
    ocrLang: String(settings.ocrLang || "en"),
  };

  const profile = loadProfile(game);
  profile.overlay_settings = normalized;
  saveProfile(game, profile);
  return normalized;
}

function saveCaptureRegion(game: string, region: CaptureRegion): void {
  const profile = loadProfile(game);
  const targetDisplay = screen.getDisplayNearestPoint({
    x: Math.round(region.left + region.width / 2),
    y: Math.round(region.top + region.height / 2),
  });
  profile.capture_region = region;
  profile.capture_display_id = targetDisplay.id;

  const existing = (profile.overlay_settings || {}) as OverlaySettings;
  const displayBounds = targetDisplay.bounds;
  const captureCenterX = region.left - displayBounds.x + region.width / 2;
  const displayCenterX = displayBounds.width / 2;
  const offsetX = Math.round(captureCenterX - displayCenterX);
  const offsetY = Math.round(region.top - displayBounds.y + region.height);
  const width = Math.round(region.width);
  profile.overlay_settings = {
    ...DEFAULT_SETTINGS,
    ...existing,
    offsetX,
    offsetY,
    width,
    captureRegion: {
      left: Math.round(region.left - displayBounds.x),
      top: Math.round(region.top - displayBounds.y),
      width,
      height: Math.round(region.height),
    },
  };

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

  const settings = getOverlaySettings(gameId);
  win.setIgnoreMouseEvents(settings.clickthrough, { forward: true });

  return win;
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

ipcMain.on("display-selected", (event) => {
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

ipcMain.handle("picker:submit", (_event, region: CaptureRegion) => {
  if (region.width <= 0 || region.height <= 0) {
    return { status: "invalid" };
  }

  saveCaptureRegion(gameId, region);
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
      { type: "separator" },
      {
        role: "quit",
        label: "Quit",
      },
    ],
  },
];

app.whenReady().then(() => {
  ensureProfileExists(gameId);

  globalShortcut.register("CommandOrControl+Shift+R", () => {
    openRegionPickerWindows().catch((err) => {
      console.error("[overlay] picker failed:", err);
    });
  });
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("overlay:toggle-panel");
    }
  });
  globalShortcut.register("CommandOrControl+Shift+C", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("overlay:copy-current");
    }
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  overlayWindow = createOverlayWindow();

  if (!hasCaptureRegion(gameId)) {
    openRegionPickerWindows().catch((err) => {
      console.error("[overlay] initial picker failed:", err);
    });
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
