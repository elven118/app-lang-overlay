export {};

declare global {
  interface Window {
    overlayApi: {
      getSettings: () => Promise<{
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
      }>;
      saveSettings: (payload: {
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
      }) => Promise<{
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
      }>;
      setClickthrough: (enabled: boolean) => Promise<boolean>;
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
      onStartDrag: (callback: (payload: { originX: number; originY: number }) => void) => void;
    };
  }
}
