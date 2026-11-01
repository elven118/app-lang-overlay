import type {
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
  CaptureRegion,
} from './shared/types';

export {};

declare global {
  interface Window {
    windowPickerApi: {
      getState: () => Promise<WindowHover>;
      onHover: (callback: (state: WindowHover) => void) => void;
      select: () => Promise<boolean>;
      cancel: () => Promise<void>;
    };
    overlayApi: {
      setSelectionPreview: (visible: boolean) => Promise<void>;
      onSelectionPreview: (callback: (visible: boolean) => void) => void;
      getViewport: () => Promise<OverlayViewport>;
      onCaptureBounds: (callback: (payload: { regionId: string; bounds: DesktopRect }) => void) => void;
      onSettings: (callback: (settings: OverlaySettings) => void) => void;
      getSettings: () => Promise<OverlaySettings>;
      saveSettings: (payload: OverlaySettings) => Promise<OverlaySettings>;
      copyText: (text: string) => Promise<boolean>;
      getProfileId: () => Promise<string>;
      getLatestTranslations: () => Promise<DesktopTranslationResult[]>;
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
      onTranslationResult: (callback: (payload: DesktopTranslationResult) => void) => void;
      onTranslationClear: (callback: (payload: TranslationClear) => void) => void;
      onStreamStatus: (callback: (payload: StreamStatus) => void) => void;
    };
    pickerApi: {
      select: () => void;
      submit: (region: CaptureRegion | CaptureRegion[]) => Promise<{ status: string }>;
      cancel: () => Promise<unknown>;
      onStartDrag: (
        callback: (payload: PickerStart) => void
      ) => void;
    };
    controlApi: {
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
      getStreamStatus: () => Promise<StreamStatus>;
      getPaused: () => Promise<boolean>;
      togglePause: () => Promise<boolean>;
      onStreamStatus: (callback: (payload: StreamStatus) => void) => void;
      onProfileChanged: (callback: (payload: ProfileState) => void) => void;
    };
  }
}
