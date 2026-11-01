import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  Display,
  globalShortcut,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  screen,
  type Tray,
} from "electron";
import { DesktopStream } from "./main/backend-client";
import { DesktopCapture, type CaptureTarget } from "./main/capture";
import { ProfileStore } from "./main/profile-store";
import { createAppTray } from "./main/tray";
import { HoverWindowPicker } from "./main/window-picker";
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
  DesktopTranslationResult,
  DesktopRect,
  WindowChoice,
  PickerStart,
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
  showSource: false,
  width: 600,
  sourceFontSize: 12,
  translatedFontSize: 12,
  lineGap: 10,
  textColor: "#ffffff",
  translateColor: "#ffd166",
  background: "rgba(0,0,0,0.35)",
  autoHideMs: -1,
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
  return ["selected_window", "one_large_area", "multiple_regions"].includes(String(value || ""))
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
    showSource: typeof raw.showSource === "boolean" ? raw.showSource : DEFAULT_SETTINGS.showSource,
    placementMode,
    placement,
    width,
    sourceFontSize: Math.max(0, Math.round(asFiniteNumber(raw.sourceFontSize, DEFAULT_SETTINGS.sourceFontSize))),
    translatedFontSize: Math.max(
      0,
      Math.round(asFiniteNumber(raw.translatedFontSize, DEFAULT_SETTINGS.translatedFontSize)),
    ),
    lineGap: Math.max(0, Math.round(asFiniteNumber(raw.lineGap, DEFAULT_SETTINGS.lineGap))),
    autoHideMs: Math.max(-1, Math.round(asFiniteNumber(raw.autoHideMs, DEFAULT_SETTINGS.autoHideMs))),
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

function settingsForProfile(settings: OverlaySettings): Omit<OverlaySettings, "backendUrl" | "backendToken" | "captureRegions"> {
  const { backendUrl: _backendUrl, backendToken: _backendToken, captureRegions: _captureRegions, ...profileSettings } = settings;
  return profileSettings;
}

const profileStore = new ProfileStore(path.join(repoRoot, "data", "profiles"));
let profileId = profileStore.resolveInitial(process.env.OVERLAY_DEFAULT_PROFILE);

let overlayWindow: BrowserWindow | null = null;
let secondaryOverlays: BrowserWindow[] = [];
let controlWindow: BrowserWindow | null = null;
let transcriptWindow: BrowserWindow | null = null;
let selectionWindows: SelectionWindow[] = [];
let areaPickerSettings: OverlaySettings | null = null;
let windowPicker: HoverWindowPicker | null = null;
// OS window IDs are temporary. Always ask again after restart/profile switch.
let selectedWindowSource: WindowChoice | null = null;
let appMenu: Menu | null = null;
let tray: Tray | null = null;
let quitting = false;
let streamStatus: StreamStatus = { state: "offline", message: "Not connected" };
const latestTranslations = new Map<string, DesktopTranslationResult>();
const transcriptHistory: TranslationResult[] = [];
const captureBounds = new Map<string, DesktopRect>();
const desktopCapture = new DesktopCapture(undefined, publishCaptureBounds, () =>
  [overlayWindow, ...secondaryOverlays].filter((win): win is BrowserWindow => !!win && !win.isDestroyed())
    .map((win) => win.getMediaSourceId().split(':')[1]));
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
  if (selectionWindows.length > 0 || windowPicker) return [];
  const profile = loadProfile(profileId);
  const settings = getOverlaySettings(profileId);
  const defaultDisplay = getTargetDisplay(profile);
  if (settings.mode === "selected_window") {
    return selectedWindowSource ? [{
      regionId: 'window-1', display: defaultDisplay, windowSource: selectedWindowSource,
    }] : [];
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
  if (settings.mode === "selected_window") return selectedWindowSource !== null;
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
  return withCaptureRegionPreviews(normalized, profile, targetDisplay);
}

function withCaptureRegionPreviews(settings: OverlaySettings, profile: Record<string, unknown>, fallback: Display): OverlaySettings {
  if (settings.mode !== 'multiple_regions') return settings;
  const saved = normalizeCaptureRegions(profile.capture_regions);
  const primary = normalizeCaptureRegion(profile.capture_region);
  const regions = saved.length ? saved : primary ? [primary] : [];
  return { ...settings, captureRegions: regions.map((region) => {
    const display = displayForCaptureRegion(region, fallback);
    const scale = process.platform === 'win32' ? (display.scaleFactor || 1) : 1;
    return { left: region.left / scale, top: region.top / scale, width: region.width / scale, height: region.height / scale };
  }) };
}

function saveOverlaySettings(id: string, settings: OverlaySettings): OverlaySettings {
  const profile = loadProfile(id);
  const targetDisplay = getTargetDisplay(profile);
  const normalized = normalizeOverlaySettings(settings, targetDisplay.bounds);
  profile.overlay_settings = settingsForProfile(normalized);
  saveProfile(id, profile);
  return withCaptureRegionPreviews(normalized, profile, targetDisplay);
}

function saveCaptureRegion(
  id: string,
  region: CaptureRegion,
  pickerWindowBounds?: { x: number; y: number },
  multipleRegions?: CaptureRegion[],
  selectionSettings?: OverlaySettings,
): void {
  const profile = loadProfile(id);
  const targetDisplay = screen.getDisplayNearestPoint({
    x: Math.round(region.left + region.width / 2),
    y: Math.round(region.top + region.height / 2),
  });
  const scaleFactor = process.platform === "win32" ? (targetDisplay.scaleFactor || 1) : 1;
  const toDip = (value: number): number => value / scaleFactor;

  profile.capture_region = region;
  profile.capture_display_id = targetDisplay.id;

  const currentSettings = normalizeOverlaySettings(selectionSettings ?? profile.overlay_settings, targetDisplay.bounds);
  if (currentSettings.mode === "multiple_regions" && multipleRegions) profile.capture_regions = multipleRegions;

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

  const existing = currentSettings;
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

function setOverlayInteraction(settingsVisible: boolean): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(!settingsVisible, { forward: true });
  }
  secondaryOverlays.forEach((win) => { if (!win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true }); });
}

function sendToDesktopRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function publishTranslation(result: DesktopTranslationResult): void {
  result = { ...result, captureBounds: captureBounds.get(result.regionId) ?? result.captureBounds };
  latestTranslations.set(result.regionId, result);
  const previous = transcriptHistory.at(-1);
  if (!previous || previous.dedupeKey !== result.dedupeKey || previous.regionId !== result.regionId) {
    transcriptHistory.push(result);
    if (transcriptHistory.length > 500) transcriptHistory.shift();
  }
  sendToDesktopRenderers("translation:result", result);
}

function publishCaptureBounds(regionId: string, bounds: DesktopRect): void {
  const previous = captureBounds.get(regionId);
  if (previous && JSON.stringify(previous) === JSON.stringify(bounds)) return;
  captureBounds.set(regionId, bounds);
  const latest = latestTranslations.get(regionId);
  if (latest) latest.captureBounds = bounds;
  sendToDesktopRenderers('capture:bounds', { regionId, bounds });
}

function publishClear(message: TranslationClear): void {
  latestTranslations.delete(message.regionId);
  sendToDesktopRenderers("translation:clear", message);
}

function publishStreamStatus(status: StreamStatus): void {
  if (status.state === 'paused' || status.state === 'offline') desktopCapture.stop();
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
  selectedWindowSource = null;
  captureBounds.clear();
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
  if (!hasCaptureRegion(profileId)) void openRegionPickerWindows();
  return publishProfileState();
}

function createOverlayWindow(display?: Display): BrowserWindow {
  const profile = loadProfile(profileId);
  const targetDisplay = display ?? getTargetDisplay(profile);
  const bounds = targetDisplay.bounds;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    show: process.platform !== 'win32',
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

  if (process.platform === 'win32') {
    win.setContentProtection(true);
    win.show();
  }
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "renderer/overlay/index.html"));
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      event.preventDefault();
      win.webContents.send("overlay:close-panel");
    }
  });

  win.setIgnoreMouseEvents(true, { forward: true });

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
    win.hide();
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
  }

  overlayWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
  overlayWindow.webContents.reloadIgnoringCache();
  refreshSecondaryOverlays();
}

function refreshSecondaryOverlays(): void {
  secondaryOverlays.forEach((win) => { if (!win.isDestroyed()) win.destroy(); });
  secondaryOverlays = [];
  if (getOverlaySettings(profileId).mode === 'one_large_area') return;
  const primary = getTargetDisplay(loadProfile(profileId));
  secondaryOverlays = screen.getAllDisplays().filter((display) => display.id !== primary.id)
    .map((display) => createOverlayWindow(display));
}

async function listCaptureWindows(): Promise<WindowChoice[]> {
  const ownIds = new Set(BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed()).map((win) => win.getMediaSourceId()));
  const sources = await desktopCapturer.getSources({
    types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false,
  });
  return sources.filter((source) => !ownIds.has(source.id) && source.id.startsWith('window:'))
    .map(({ id, name }) => ({ id, name: name || 'Untitled window' }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function openRegionPickerWindows(captureSettings = getOverlaySettings(profileId)) {
  closeRegionPickerWindows();
  if (captureSettings.mode === 'selected_window') {
    const picker = new HoverWindowPicker(__dirname, async (windowId) => {
      const source = (await listCaptureWindows()).find((choice) => choice.id.split(':')[1] === String(windowId));
      if (!source) throw new Error('That window is no longer available. Hover over another window.');
      if (windowPicker !== picker) return;
      selectedWindowSource = source;
      captureBounds.clear();
      saveOverlaySettings(profileId, captureSettings);
      closeRegionPickerWindows();
      latestTranslations.clear();
      desktopCapture.stop();
      desktopStream?.refreshCapture();
      refreshOverlayWindowForProfile();
      publishProfileState();
    });
    windowPicker = picker;
    picker.onCancel = () => { if (windowPicker === picker) closeRegionPickerWindows(); };
    try { await picker.start(); }
    catch (error) {
      picker.dispose();
      if (windowPicker === picker) windowPicker = null;
      const message = error instanceof Error ? error.message : String(error);
      console.error('[window-picker]', message);
      publishStreamStatus({ state: 'error', message: `Window selection failed: ${message}` });
    }
    return;
  }

  areaPickerSettings = captureSettings;
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
        win.webContents.send("picker:start-drag", pickerStartPayload(win));
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

function pickerStartPayload(win: SelectionWindow): PickerStart {
  const display = win.display!;
  const bounds = win.getBounds();
  const profile = loadProfile(profileId);
  const multiple = (areaPickerSettings ?? getOverlaySettings(profileId)).mode === 'multiple_regions';
  const saved = normalizeCaptureRegions(profile.capture_regions);
  const primary = normalizeCaptureRegion(profile.capture_region);
  const regions = multiple ? (saved.length ? saved : primary ? [primary] : []) : [];
  const local = regions.filter((region) => displayForCaptureRegion(region, display).id === display.id);
  return { originX: bounds.x, originY: bounds.y,
    captureScaleFactor: process.platform === 'win32' ? (display.scaleFactor || 1) : 1,
    multiple, regions: local, otherRegionCount: regions.length - local.length };
}

function closeRegionPickerWindows(): void {
  setOverlayInteraction(false);
  sendToDesktopRenderers('overlay:selection-preview', false);
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('overlay:close-panel');
  areaPickerSettings = null;
  windowPicker?.dispose();
  windowPicker = null;
  selectionWindows.forEach((win) => {
    if (!win.isDestroyed()) {
      win.close();
    }
  });
  selectionWindows = [];
}

ipcMain.handle("overlay:get-settings", () => getOverlaySettings(profileId));
ipcMain.handle('overlay:set-selection-preview', (event, visible: boolean) => {
  if (event.sender !== overlayWindow?.webContents) return;
  setOverlayInteraction(Boolean(visible));
  sendToDesktopRenderers('overlay:selection-preview', Boolean(visible));
});
ipcMain.handle('overlay:get-viewport', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) throw new Error('Overlay window is unavailable');
  const bounds = win.getBounds();
  return { bounds, workArea: screen.getDisplayMatching(bounds).workArea };
});

ipcMain.handle("overlay:save-settings", (_event, payload: OverlaySettings) => {
  const previous = getOverlaySettings(profileId);
  if (payload.mode !== previous.mode) {
    // Every mode change chooses its capture target before committing settings.
    void openRegionPickerWindows(payload);
    return previous;
  }
  const saved = saveOverlaySettings(profileId, payload);
  if (previous.mode !== saved.mode) { captureBounds.clear(); latestTranslations.clear(); }
  desktopCapture.reset();
  desktopStream?.applySettings(previous, saved);
  sendToDesktopRenderers('overlay:settings', saved);
  if (previous.mode !== saved.mode) setImmediate(refreshOverlayWindowForProfile);
  return saved;
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
ipcMain.on("picker:selected", (event) => {
  const selectedWindow = BrowserWindow.fromWebContents(event.sender) as SelectionWindow | null;
  if (!selectedWindow || selectedWindow.isDestroyed() || !selectionWindows.includes(selectedWindow)) {
    return;
  }

  selectionWindows.forEach((win) => {
    if (win !== selectedWindow && !win.isDestroyed()) {
      win.close();
    }
  });

  selectionWindows = [selectedWindow];
  selectedWindow.focus();
  selectedWindow.webContents.send("picker:start-drag", pickerStartPayload(selectedWindow));
});

ipcMain.handle("picker:submit", (event, value: unknown) => {
  const selectedWindow = BrowserWindow.fromWebContents(event.sender) as SelectionWindow | null;
  if (!selectedWindow || selectedWindow.isDestroyed() || !selectionWindows.includes(selectedWindow) || !selectedWindow.display) {
    return { status: 'invalid' };
  }
  const selectionSettings = areaPickerSettings ?? getOverlaySettings(profileId);
  const multiple = selectionSettings.mode === 'multiple_regions';
  if (multiple !== Array.isArray(value)) return { status: 'invalid' };
  const submitted = Array.isArray(value) ? value : [value];
  const pickerBounds = selectedWindow.getBounds();
  const scale = process.platform === 'win32' ? (selectedWindow.display.scaleFactor || 1) : 1;
  const regions = submitted.map(normalizeCaptureRegion);
  if (regions.some((r) => !r || r.width < 20 * scale || r.height < 20 * scale ||
    r.left < pickerBounds.x * scale || r.top < pickerBounds.y * scale ||
    r.left + r.width > (pickerBounds.x + pickerBounds.width) * scale ||
    r.top + r.height > (pickerBounds.y + pickerBounds.height) * scale)) return { status: 'invalid' };
  const unique = [...new Map((regions as CaptureRegion[]).map((r) => [JSON.stringify(r), r])).values()];
  const profile = loadProfile(profileId);
  const savedRegions = normalizeCaptureRegions(profile.capture_regions);
  const primaryRegion = normalizeCaptureRegion(profile.capture_region);
  const existing = savedRegions.length ? savedRegions : primaryRegion ? [primaryRegion] : [];
  const otherRegions = multiple ? existing.filter((r) =>
    displayForCaptureRegion(r, selectedWindow.display!).id !== selectedWindow.display!.id) : [];
  const allRegions = [...otherRegions, ...unique];
  const region = unique[0] ?? otherRegions[0];
  if (!region) return { status: 'invalid' };

  // One profile write commits the entire edited set. Cancel never writes drafts.
  saveCaptureRegion(profileId, region, unique.length ? pickerBounds : undefined, multiple ? allRegions : undefined, selectionSettings);
  latestTranslations.clear();
  captureBounds.clear();
  desktopCapture.reset();
  desktopStream?.refreshCapture();
  refreshOverlayWindowForProfile();
  closeRegionPickerWindows();
  publishProfileState();

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
        label: "Choose Capture Target",
        click: () => {
          if (selectionWindows.length === 0) {
            void openRegionPickerWindows();
          }
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
    app.setActivationPolicy("accessory");
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
  refreshSecondaryOverlays();
  controlWindow = createControlWindow();
  transcriptWindow = createTranscriptWindow();
  tray = createAppTray(showControlWindow, () => app.quit());

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

// Keep the tray available even if every application window has been closed.
app.on('window-all-closed', () => {});

app.on("before-quit", () => {
  quitting = true;
  closeRegionPickerWindows();
  desktopStream?.stop();
  desktopCapture.stop();
});

app.on("will-quit", () => {
  tray?.destroy();
  tray = null;
  globalShortcut.unregisterAll();
});
