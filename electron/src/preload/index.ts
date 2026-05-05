import { contextBridge, ipcRenderer } from 'electron';

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

type CaptureRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

contextBridge.exposeInMainWorld('overlayApi', {
  getSettings: (): Promise<OverlaySettings> => ipcRenderer.invoke('overlay:get-settings'),
  saveSettings: (payload: OverlaySettings): Promise<OverlaySettings> => ipcRenderer.invoke('overlay:save-settings', payload),
  setClickthrough: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('overlay:set-clickthrough', enabled),
  getGameId: (): Promise<string> => ipcRenderer.invoke('overlay:get-game-id'),
  pickRegion: (): Promise<{ status: string; game_id?: string; capture_region?: CaptureRegion; profile_path?: string }> =>
    ipcRenderer.invoke('overlay:pick-region'),
  onTogglePanel: (callback: () => void) => {
    ipcRenderer.on('overlay:toggle-panel', () => callback());
  }
});

contextBridge.exposeInMainWorld('pickerApi', {
  select: () => ipcRenderer.send('display-selected'),
  submit: (region: CaptureRegion): Promise<unknown> => ipcRenderer.invoke('picker:submit', region),
  cancel: (): Promise<unknown> => ipcRenderer.invoke('picker:cancel'),
  onStartDrag: (callback: (payload: { originX: number; originY: number }) => void) => {
    ipcRenderer.on('picker:start-drag', (_event, payload) => callback(payload));
  }
});
