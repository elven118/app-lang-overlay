import type {
  OverlaySettings,
  ProfileState,
  StreamStatus,
  TranslationClear,
  TranslationResult,
} from './shared/types';

export {};

declare global {
  interface Window {
    overlayApi: {
      getSettings: () => Promise<OverlaySettings>;
      saveSettings: (payload: OverlaySettings) => Promise<OverlaySettings>;
      setClickthrough: (enabled: boolean) => Promise<boolean>;
      copyText: (text: string) => Promise<boolean>;
      getProfileId: () => Promise<string>;
      getLatestTranslations: () => Promise<TranslationResult[]>;
      getTranslationHistory: () => Promise<TranslationResult[]>;
      pickRegion: () => Promise<{
        status: string;
        profile_id?: string;
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
      onClosePanel: (callback: () => void) => void;
      onTranslationResult: (callback: (payload: TranslationResult) => void) => void;
      onTranslationClear: (callback: (payload: TranslationClear) => void) => void;
      onStreamStatus: (callback: (payload: StreamStatus) => void) => void;
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
    controlApi: {
      toggleWindow: () => Promise<boolean>;
      showWindow: () => Promise<boolean>;
      hideWindow: () => Promise<boolean>;
      getVisible: () => Promise<boolean>;
      getSettings: () => Promise<OverlaySettings>;
      getProfileState: () => Promise<ProfileState>;
      createProfile: (profileId: string) => Promise<ProfileState>;
      loadProfile: (profileId: string) => Promise<ProfileState>;
      renameProfile: (profileId: string) => Promise<ProfileState>;
      pickRegion: () => Promise<{
        status: string;
        profile_id?: string;
        capture_region?: {
          left: number;
          top: number;
          width: number;
          height: number;
        };
        profile_path?: string;
      }>;
      toggleOverlayPanel: () => Promise<boolean>;
      showTranscript: () => Promise<boolean>;
      toggleClickthrough: () => Promise<boolean>;
      getStreamStatus: () => Promise<StreamStatus>;
      getPaused: () => Promise<boolean>;
      togglePause: () => Promise<boolean>;
      onStreamStatus: (callback: (payload: StreamStatus) => void) => void;
      onProfileChanged: (callback: (payload: ProfileState) => void) => void;
    };
  }
}
