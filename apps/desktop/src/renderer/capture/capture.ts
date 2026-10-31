export {};

declare global {
  interface Window {
    screenCapture: {
      start: (size: { width?: number; height?: number }) => Promise<void>;
      snapshot: () => string | null;
    };
  }
}

let stream: MediaStream | null = null;
const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
document.body.append(video);
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d');

function stop(): void {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

window.screenCapture = {
  async start(size) {
    stop();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stage = 'requesting screen stream';
    try {
      await Promise.race([
        (async () => {
          stream = await navigator.mediaDevices.getDisplayMedia({
            audio: false,
            video: {
              ...(size.width && size.height ? { width: { ideal: size.width }, height: { ideal: size.height } } : {}),
              frameRate: { ideal: 10, max: 10 },
            },
          });
          stage = 'starting video playback';
          video.srcObject = stream;
          await video.play();
          // Frame availability is checked when sampling. A live track can
          // briefly be muted/not decoded while capture initializes or resumes.
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Screen capture timed out while ${stage}`)), 15000);
        }),
      ]);
    } catch (error) {
      stop();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  },
  snapshot() {
    const track = stream?.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') {
      throw new Error('Screen stream has ended');
    }
    // A temporary gap is not empty OCR and must not tear down a healthy stream.
    if (track.muted || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    if (!context) throw new Error('Screen capture canvas is unavailable');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0);
    return canvas.toDataURL('image/png');
  },
};

window.addEventListener('unload', stop);
