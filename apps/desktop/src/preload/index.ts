import { contextBridge, ipcRenderer } from 'electron';
import type {
  CaptureRegion,
  OverlaySettings,
  ProfileState,
  StreamStatus,
  TranslationClear,
  TranslationResult,
  WindowHover,
  DesktopTranslationResult,
  OverlayViewport,
  DesktopRect,
  PickerStart,
} from '../shared/types';

contextBridge.exposeInMainWorld('overlayApi', {
  setSelectionPreview: (visible: boolean): Promise<void> => ipcRenderer.invoke('overlay:set-selection-preview', visible),
  onSelectionPreview: (callback: (visible: boolean) => void) => {
    ipcRenderer.on('overlay:selection-preview', (_event, visible: boolean) => callback(visible));
  },
  getViewport: (): Promise<OverlayViewport> => ipcRenderer.invoke('overlay:get-viewport'),
  onCaptureBounds: (callback: (payload: { regionId: string; bounds: DesktopRect }) => void) => {
    ipcRenderer.on('capture:bounds', (_event, payload) => callback(payload));
  },
  onSettings: (callback: (settings: OverlaySettings) => void) => {
    ipcRenderer.on('overlay:settings', (_event, settings) => callback(settings));
  },
  getSettings: (): Promise<OverlaySettings> => ipcRenderer.invoke('overlay:get-settings'),
  saveSettings: (payload: OverlaySettings): Promise<OverlaySettings> => ipcRenderer.invoke('overlay:save-settings', payload),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('overlay:copy-text', text),
  getProfileId: (): Promise<string> => ipcRenderer.invoke('profile:get-active'),
  getLatestTranslations: (): Promise<DesktopTranslationResult[]> => ipcRenderer.invoke('translation:get-latest'),
  getTranslationHistory: (): Promise<TranslationResult[]> => ipcRenderer.invoke('translation:get-history'),
  pickRegion: (): Promise<{ status: string; profile_id?: string; capture_region?: CaptureRegion; profile_path?: string }> =>
    ipcRenderer.invoke('overlay:pick-region'),
  onTogglePanel: (callback: () => void) => {
    ipcRenderer.on('overlay:toggle-panel', () => callback());
  },
  onCopyCurrent: (callback: () => void) => {
    ipcRenderer.on('overlay:copy-current', () => callback());
  },
  onClosePanel: (callback: () => void) => {
    ipcRenderer.on('overlay:close-panel', () => callback());
  },
  onTranslationResult: (callback: (payload: DesktopTranslationResult) => void) => {
    ipcRenderer.on('translation:result', (_event, payload: DesktopTranslationResult) => callback(payload));
  },
  onTranslationClear: (callback: (payload: TranslationClear) => void) => {
    ipcRenderer.on('translation:clear', (_event, payload: TranslationClear) => callback(payload));
  },
  onStreamStatus: (callback: (payload: StreamStatus) => void) => {
    ipcRenderer.on('stream:status', (_event, payload: StreamStatus) => callback(payload));
  }
});

contextBridge.exposeInMainWorld('controlApi', {
  getSettings: (): Promise<OverlaySettings> => ipcRenderer.invoke('overlay:get-settings'),
  getProfileState: (): Promise<ProfileState> => ipcRenderer.invoke('profile:list'),
  createProfile: (profileId: string): Promise<ProfileState> => ipcRenderer.invoke('profile:create', profileId),
  loadProfile: (profileId: string): Promise<ProfileState> => ipcRenderer.invoke('profile:load', profileId),
  renameProfile: (profileId: string): Promise<ProfileState> => ipcRenderer.invoke('profile:rename', profileId),
  pickRegion: (): Promise<{ status: string; profile_id?: string; capture_region?: CaptureRegion; profile_path?: string }> =>
    ipcRenderer.invoke('overlay:pick-region'),
  toggleOverlayPanel: (): Promise<boolean> => ipcRenderer.invoke('control:toggle-overlay-panel'),
  showTranscript: (): Promise<boolean> => ipcRenderer.invoke('control:show-transcript'),
  getStreamStatus: (): Promise<StreamStatus> => ipcRenderer.invoke('stream:get-status'),
  getPaused: (): Promise<boolean> => ipcRenderer.invoke('stream:get-paused'),
  togglePause: (): Promise<boolean> => ipcRenderer.invoke('stream:toggle-pause'),
  onStreamStatus: (callback: (payload: StreamStatus) => void) => {
    ipcRenderer.on('stream:status', (_event, payload: StreamStatus) => callback(payload));
  },
  onProfileChanged: (callback: (payload: ProfileState) => void) => {
    ipcRenderer.on('profile:changed', (_event, payload: ProfileState) => callback(payload));
  }
});

contextBridge.exposeInMainWorld('windowPickerApi', {
  getState: (): Promise<WindowHover> => ipcRenderer.invoke('window-picker:state'),
  onHover: (callback: (state: WindowHover) => void) => {
    ipcRenderer.on('window-picker:hover', (_event, state: WindowHover) => callback(state));
  },
  select: (): Promise<boolean> => ipcRenderer.invoke('window-picker:select'),
  cancel: (): Promise<void> => ipcRenderer.invoke('window-picker:cancel'),
});

contextBridge.exposeInMainWorld('pickerApi', {
  select: () => ipcRenderer.send('picker:selected'),
  submit: (region: CaptureRegion | CaptureRegion[]): Promise<{ status: string }> => ipcRenderer.invoke('picker:submit', region),
  cancel: (): Promise<unknown> => ipcRenderer.invoke('picker:cancel'),
  onStartDrag: (callback: (payload: PickerStart) => void) => {
    ipcRenderer.on('picker:start-drag', (_event, payload) => callback(payload));
  }
});
