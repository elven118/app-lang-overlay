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
import { DesktopStream } from "./main/backend-client";
import { DesktopCapture, type CaptureTarget } from "./main/capture";
import { ProfileStore } from "./main/profile-store";
import type {
  CaptureMode,
  CaptureRegion,
  OverlaySettings,
  ProfileState,
  SourceLanguage,
  StreamStatus,
  TargetLanguage,
  TranslationClear,
  TranslationResult,
} from "./shared/types";

interface SelectionWindow extends BrowserWindow {
  display?: Display;
  displayIndex?: number;
}

const desktopRoot = path.resolve(__dirname, "..");
try {
  process.loadEnvFile(path.join(desktopRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const repoRoot = path.resolve(__dirname, "../../..");

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
  targetLanguage: "zh-Hant",
  mode: "one_large_area",
  polling_ms: 900,
  backendUrl: process.env.OVERLAY_BACKEND_URL || "ws://127.0.0.1:8765/v1/stream",
  backendToken: process.env.OVERLAY_BACKEND_TOKEN || "",
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

function normalizeCaptureRegions(value: unknown): CaptureRegion[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeCaptureRegion).filter((item): item is CaptureRegion => Boolean(item));
}

function normalizeSourceLanguage(value: unknown): SourceLanguage {
  const aliases: Record<string, SourceLanguage> = {
    japan: "ja",
    ch: "zh-Hans",
    chinese_cht: "zh-Hant",
    korean: "ko",
  };
  const normalized = aliases[String(value || "")] || String(value || "");
  return ["auto", "en", "ja", "ko", "zh-Hans", "zh-Hant"].includes(normalized)
    ? normalized as SourceLanguage
    : DEFAULT_SETTINGS.ocrLang;
}

function normalizeTargetLanguage(value: unknown): TargetLanguage {
  return ["en", "zh-Hant", "ja"].includes(String(value || ""))
    ? value as TargetLanguage
    : DEFAULT_SETTINGS.targetLanguage;
}

function normalizeCaptureMode(value: unknown): CaptureMode {
  return ["full_screen", "one_large_area", "multiple_regions"].includes(String(value || ""))
    ? value as CaptureMode
    : DEFAULT_SETTINGS.mode;
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
  const captureRegions = normalizeCaptureRegions(raw.captureRegions);
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

  const normalized = {
    ...DEFAULT_SETTINGS,
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
    ocrLang: normalizeSourceLanguage(raw.ocrLang),
    targetLanguage: normalizeTargetLanguage(raw.targetLanguage),
    mode: normalizeCaptureMode(raw.mode),
    polling_ms: clamp(Math.round(asFiniteNumber(
      raw.polling_ms ?? (raw as unknown as { poll_ms?: unknown }).poll_ms,
      DEFAULT_SETTINGS.polling_ms,
    )), 100, 60_000),
    backendUrl: process.env.OVERLAY_BACKEND_URL || DEFAULT_SETTINGS.backendUrl,
    backendToken: process.env.OVERLAY_BACKEND_TOKEN || DEFAULT_SETTINGS.backendToken,
    background,
    textColor,
    translateColor,
    captureRegion,
    captureRegions,
  };
  delete (normalized as OverlaySettings & { poll_ms?: unknown }).poll_ms;
  return normalized;
}

function settingsForProfile(settings: OverlaySettings): Omit<OverlaySettings, "backendUrl" | "backendToken"> {
  const { backendUrl: _backendUrl, backendToken: _backendToken, ...profileSettings } = settings;
  return profileSettings;
}

const profileStore = new ProfileStore(path.join(repoRoot, "data", "profiles"));
let profileId = profileStore.resolveInitial(process.env.OVERLAY_DEFAULT_PROFILE);

let overlayWindow: BrowserWindow | null = null;
let controlWindow: BrowserWindow | null = null;
let transcriptWindow: BrowserWindow | null = null;
let selectionWindows: SelectionWindow[] = [];
let appMenu: Menu | null = null;
let quitting = false;
let streamStatus: StreamStatus = { state: "offline", message: "Not connected" };
const latestTranslations = new Map<string, TranslationResult>();
const transcriptHistory: TranslationResult[] = [];
const desktopCapture = new DesktopCapture();
let desktopStream: DesktopStream | null = null;

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

function displayForCaptureRegion(region: CaptureRegion, fallback: Display): Display {
  const center = {
    x: region.left + region.width / 2,
    y: region.top + region.height / 2,
  };
  const match = screen.getAllDisplays().find((display) => {
    const scale = process.platform === "win32" ? (display.scaleFactor || 1) : 1;
    const left = display.bounds.x * scale;
    const top = display.bounds.y * scale;
    const right = left + display.bounds.width * scale;
    const bottom = top + display.bounds.height * scale;
    return center.x >= left && center.x < right && center.y >= top && center.y < bottom;
  });
  return match ?? fallback;
}

function getCaptureTargets(): CaptureTarget[] {
  const profile = loadProfile(profileId);
  const settings = getOverlaySettings(profileId);
  const defaultDisplay = getTargetDisplay(profile);
  if (settings.mode === "full_screen") {
    return [{ regionId: `screen-${defaultDisplay.id}`, display: defaultDisplay }];
  }

  const primaryRegion = normalizeCaptureRegion(profile.capture_region);
  if (settings.mode === "one_large_area") {
    return primaryRegion
      ? [{ regionId: "region-1", display: displayForCaptureRegion(primaryRegion, defaultDisplay), region: primaryRegion }]
      : [];
  }

  const savedRegions = normalizeCaptureRegions(profile.capture_regions);
  const regions = savedRegions.length > 0 ? savedRegions : (primaryRegion ? [primaryRegion] : []);
  return regions.map((region, index) => ({
    regionId: `region-${index + 1}`,
    display: displayForCaptureRegion(region, defaultDisplay),
    region,
  }));
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

function loadProfile(id: string): Record<string, unknown> {
  return profileStore.load(id);
}

function saveProfile(id: string, profile: Record<string, unknown>): void {
  profileStore.save(id, profile);
}

function ensureProfileExists(id: string): Record<string, unknown> {
  if (!profileStore.exists(id)) {
    profileStore.create(id);
  }
  const profile = loadProfile(id);
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
  profile.overlay_settings = settingsForProfile(normalized);
  saveProfile(id, profile);
  return profile;
}

function hasCaptureRegion(id: string): boolean {
  const profile = loadProfile(id);
  const settings = getOverlaySettings(id);
  if (settings.mode === "full_screen") return true;
  if (settings.mode === "multiple_regions" && normalizeCaptureRegions(profile.capture_regions).length > 0) {
    return true;
  }
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

function getOverlaySettings(id: string): OverlaySettings {
  const profile = loadProfile(id);
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
  profile.overlay_settings = settingsForProfile(normalized);
  saveProfile(id, profile);
  return normalized;
}

function saveOverlaySettings(id: string, settings: OverlaySettings): OverlaySettings {
  const profile = loadProfile(id);
  const targetDisplay = getTargetDisplay(profile);
  const normalized = normalizeOverlaySettings(settings, targetDisplay.bounds);
  profile.overlay_settings = settingsForProfile(normalized);
  saveProfile(id, profile);
  return normalized;
}

function saveCaptureRegion(
  id: string,
  region: CaptureRegion,
  pickerWindowBounds?: { x: number; y: number },
): void {
  const profile = loadProfile(id);
  const previousPrimaryRegion = normalizeCaptureRegion(profile.capture_region);
  const targetDisplay = screen.getDisplayNearestPoint({
    x: Math.round(region.left + region.width / 2),
    y: Math.round(region.top + region.height / 2),
  });
  const scaleFactor = process.platform === "win32" ? (targetDisplay.scaleFactor || 1) : 1;
  const toDip = (value: number): number => value / scaleFactor;

  profile.capture_region = region;
  profile.capture_display_id = targetDisplay.id;

  const currentSettings = normalizeOverlaySettings(profile.overlay_settings, targetDisplay.bounds);
  if (currentSettings.mode === "multiple_regions") {
    const existingRegions = normalizeCaptureRegions(profile.capture_regions);
    const seededRegions = existingRegions.length > 0
      ? existingRegions
      : previousPrimaryRegion
        ? [previousPrimaryRegion]
        : [];
    const duplicate = seededRegions.some((item) => (
      item.left === region.left
      && item.top === region.top
      && item.width === region.width
      && item.height === region.height
    ));
    profile.capture_regions = duplicate ? seededRegions : [...seededRegions, region];
  }

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
  const normalized = normalizeOverlaySettings({
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
  profile.overlay_settings = settingsForProfile(normalized);

  saveProfile(id, profile);
}

function applyClickthrough(enabled: boolean): boolean {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }
  overlayWindow.setIgnoreMouseEvents(enabled, { forward: true });
  return enabled;
}

function sendToDesktopRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function publishTranslation(result: TranslationResult): void {
  latestTranslations.set(result.regionId, result);
  const previous = transcriptHistory.at(-1);
  if (!previous || previous.dedupeKey !== result.dedupeKey || previous.regionId !== result.regionId) {
    transcriptHistory.push(result);
    if (transcriptHistory.length > 500) transcriptHistory.shift();
  }
  sendToDesktopRenderers("translation:result", result);
}

function publishClear(message: TranslationClear): void {
  latestTranslations.delete(message.regionId);
  sendToDesktopRenderers("translation:clear", message);
}

function publishStreamStatus(status: StreamStatus): void {
  streamStatus = status;
  sendToDesktopRenderers("stream:status", status);
}

function getProfileState(): ProfileState {
  return {
    activeProfileId: profileId,
    profiles: profileStore.list(),
  };
}

function publishProfileState(): ProfileState {
  const state = getProfileState();
  sendToDesktopRenderers("profile:changed", state);
  return state;
}

function activateProfile(nextProfileId: string): ProfileState {
  closeRegionPickerWindows();
  profileId = profileStore.setActive(nextProfileId);
  ensureProfileExists(profileId);
  latestTranslations.clear();
  transcriptHistory.length = 0;
  desktopCapture.reset();
  desktopStream?.refreshCapture();
  refreshOverlayWindowForProfile();
  if (transcriptWindow && !transcriptWindow.isDestroyed()) {
    transcriptWindow.webContents.reloadIgnoringCache();
  }
  applyClickthrough(getOverlaySettings(profileId).clickthrough);
  return publishProfileState();
}

function createOverlayWindow(): BrowserWindow {
  const profile = loadProfile(profileId);
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
  win.loadFile(path.join(__dirname, "renderer/overlay/index.html"));
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      event.preventDefault();
      win.webContents.send("overlay:close-panel");
    }
  });

  const settings = getOverlaySettings(profileId);
  win.setIgnoreMouseEvents(settings.clickthrough, { forward: true });

  return win;
}

function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 520,
    minWidth: 380,
    minHeight: 460,
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

function createTranscriptWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 680,
    height: 560,
    minWidth: 420,
    minHeight: 320,
    title: "OCR Translation Transcript",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload/index.js"),
    },
  });
  win.loadFile(path.join(__dirname, "renderer/transcript/index.html"));
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  return win;
}

function showTranscriptWindow(): void {
  if (!transcriptWindow || transcriptWindow.isDestroyed()) {
    transcriptWindow = createTranscriptWindow();
  }
  if (transcriptWindow.isMinimized()) transcriptWindow.restore();
  transcriptWindow.show();
  transcriptWindow.focus();
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
  const profile = loadProfile(profileId);
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

ipcMain.handle("overlay:get-settings", () => getOverlaySettings(profileId));

ipcMain.handle("overlay:save-settings", (_event, payload: OverlaySettings) => {
  const previous = getOverlaySettings(profileId);
  const saved = saveOverlaySettings(profileId, payload);
  applyClickthrough(saved.clickthrough);
  desktopCapture.reset();
  desktopStream?.applySettings(previous, saved);
  return saved;
});

ipcMain.handle("overlay:set-clickthrough", (_event, enabled: boolean) => {
  const current = getOverlaySettings(profileId);
  const saved = saveOverlaySettings(profileId, { ...current, clickthrough: Boolean(enabled) });
  return applyClickthrough(saved.clickthrough);
});

ipcMain.handle("profile:get-active", () => profileId);
ipcMain.handle("profile:list", () => getProfileState());
ipcMain.handle("profile:create", (_event, nextProfileId: unknown) => {
  profileStore.create(String(nextProfileId ?? ""));
  return activateProfile(String(nextProfileId ?? ""));
});
ipcMain.handle("profile:load", (_event, nextProfileId: unknown) => (
  activateProfile(String(nextProfileId ?? ""))
));
ipcMain.handle("profile:rename", (_event, nextProfileId: unknown) => {
  profileId = profileStore.rename(profileId, String(nextProfileId ?? ""));
  profileStore.setActive(profileId);
  refreshOverlayWindowForProfile();
  return publishProfileState();
});
ipcMain.handle("translation:get-latest", () => [...latestTranslations.values()]);
ipcMain.handle("translation:get-history", () => [...transcriptHistory]);
ipcMain.handle("stream:get-status", () => streamStatus);
ipcMain.handle("stream:get-paused", () => desktopStream?.isPaused() ?? false);
ipcMain.handle("stream:toggle-pause", () => desktopStream?.togglePaused() ?? false);
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
ipcMain.handle("control:show-transcript", () => {
  showTranscriptWindow();
  return true;
});
ipcMain.handle("control:toggle-clickthrough", () => {
  const settings = getOverlaySettings(profileId);
  const next = !settings.clickthrough;
  saveOverlaySettings(profileId, { ...settings, clickthrough: next });
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

  saveCaptureRegion(profileId, region, pickerBounds);
  desktopCapture.reset();
  desktopStream?.refreshCapture();
  refreshOverlayWindowForProfile();
  closeRegionPickerWindows();

  return {
    status: "ok",
    profile_id: profileId,
    capture_region: region,
    profile_path: profileStore.pathFor(profileId),
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
          const settings = getOverlaySettings(profileId);
          const next = !settings.clickthrough;
          saveOverlaySettings(profileId, { ...settings, clickthrough: next });
          applyClickthrough(next);
        },
      },
      {
        label: "Pause/Resume Capture",
        click: () => {
          desktopStream?.togglePaused();
        },
      },
      {
        label: "Show Transcript",
        click: () => {
          showTranscriptWindow();
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
  {
    label: 'Edit',
    submenu: [
      { role: 'copy' },
      { role: 'selectAll' }
    ]
  },
];

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    app.dock?.show();
  }

  ensureProfileExists(profileId);
  profileId = profileStore.setActive(profileId);

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
  transcriptWindow = createTranscriptWindow();
  showControlWindow();

  desktopStream = new DesktopStream({
    appVersion: app.getVersion(),
    getSettings: () => getOverlaySettings(profileId),
    captureFrames: () => desktopCapture.capture(getCaptureTargets()),
    onResult: publishTranslation,
    onClear: publishClear,
    onStatus: publishStreamStatus,
  });
  desktopStream.start();

  if (!hasCaptureRegion(profileId)) {
    openRegionPickerWindows().catch((err) => {
      console.error("[overlay] initial picker failed:", err);
    });
  }
});

app.on("activate", () => {
  showControlWindow();
});

app.on("before-quit", () => {
  quitting = true;
  desktopStream?.stop();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
