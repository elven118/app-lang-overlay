import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureRegion, OverlaySettings } from '../shared/types';

contextBridge.exposeInMainWorld('overlayApi', {
  getSettings: (): Promise<OverlaySettings> => ipcRenderer.invoke('overlay:get-settings'),
  saveSettings: (payload: OverlaySettings): Promise<OverlaySettings> => ipcRenderer.invoke('overlay:save-settings', payload),
  setClickthrough: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('overlay:set-clickthrough', enabled),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('overlay:copy-text', text),
  getGameId: (): Promise<string> => ipcRenderer.invoke('overlay:get-game-id'),
  pickRegion: (): Promise<{ status: string; game_id?: string; capture_region?: CaptureRegion; profile_path?: string }> =>
    ipcRenderer.invoke('overlay:pick-region'),
  onTogglePanel: (callback: () => void) => {
    ipcRenderer.on('overlay:toggle-panel', () => callback());
  },
  onCopyCurrent: (callback: () => void) => {
    ipcRenderer.on('overlay:copy-current', () => callback());
  },
  onClosePanel: (callback: () => void) => {
    ipcRenderer.on('overlay:close-panel', () => callback());
  }
});

contextBridge.exposeInMainWorld('controlApi', {
  toggleWindow: (): Promise<boolean> => ipcRenderer.invoke('control:toggle-window'),
  showWindow: (): Promise<boolean> => ipcRenderer.invoke('control:show-window'),
  hideWindow: (): Promise<boolean> => ipcRenderer.invoke('control:hide-window'),
  getVisible: (): Promise<boolean> => ipcRenderer.invoke('control:get-visible'),
  getSettings: (): Promise<OverlaySettings> => ipcRenderer.invoke('overlay:get-settings'),
  getGameId: (): Promise<string> => ipcRenderer.invoke('overlay:get-game-id'),
  pickRegion: (): Promise<{ status: string; game_id?: string; capture_region?: CaptureRegion; profile_path?: string }> =>
    ipcRenderer.invoke('overlay:pick-region'),
  toggleOverlayPanel: (): Promise<boolean> => ipcRenderer.invoke('control:toggle-overlay-panel'),
  toggleClickthrough: (): Promise<boolean> => ipcRenderer.invoke('control:toggle-clickthrough')
});

contextBridge.exposeInMainWorld('pickerApi', {
  select: () => ipcRenderer.send('picker:selected'),
  submit: (region: CaptureRegion): Promise<unknown> => ipcRenderer.invoke('picker:submit', region),
  cancel: (): Promise<unknown> => ipcRenderer.invoke('picker:cancel'),
  onStartDrag: (callback: (payload: { originX: number; originY: number; captureScaleFactor: number }) => void) => {
    ipcRenderer.on('picker:start-drag', (_event, payload) => callback(payload));
  }
});
