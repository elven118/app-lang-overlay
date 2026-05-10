import type { OverlaySettings } from './shared/types';

export {};

declare global {
  interface Window {
    overlayApi: {
      getSettings: () => Promise<OverlaySettings>;
      saveSettings: (payload: OverlaySettings) => Promise<OverlaySettings>;
      setClickthrough: (enabled: boolean) => Promise<boolean>;
      copyText: (text: string) => Promise<boolean>;
      getGameId: () => Promise<string>;
      pickRegion: () => Promise<{
        status: string;
        game_id?: string;
        capture_region?: {
          left: number;
          top: number;
          width: number;
          height: number;
        };
        profile_path?: string;
      }>;
      onTogglePanel: (callback: () => void) => void;
      onCopyCurrent: (callback: () => void) => void;
    };
    pickerApi: {
      select: () => void;
      submit: (region: {
        left: number;
        top: number;
        width: number;
        height: number;
      }) => Promise<unknown>;
      cancel: () => Promise<unknown>;
      onStartDrag: (
        callback: (payload: { originX: number; originY: number; captureScaleFactor: number }) => void
      ) => void;
    };
  }
}
