const statusLine = document.getElementById("status-line") as HTMLParagraphElement;
const pickRegionButton = document.getElementById("btn-pick-region") as HTMLButtonElement;
const toggleClickthroughButton = document.getElementById("btn-toggle-clickthrough") as HTMLButtonElement;
const toggleSettingsButton = document.getElementById("btn-toggle-settings") as HTMLButtonElement;

function setStatus(text: string): void {
  statusLine.textContent = text;
}

async function refreshStatus(): Promise<void> {
  const [gameId, settings] = await Promise.all([
    window.controlApi.getGameId(),
    window.controlApi.getSettings(),
  ]);
  const clickthrough = settings.clickthrough ? "ON" : "OFF";
  setStatus(`Profile: ${gameId} | OCR: ${settings.ocrLang} | Clickthrough: ${clickthrough}`);
}

pickRegionButton.addEventListener("click", async () => {
  setStatus("Opening region picker...");
  await window.controlApi.pickRegion();
  await refreshStatus();
});

toggleClickthroughButton.addEventListener("click", async () => {
  const enabled = await window.controlApi.toggleClickthrough();
  setStatus(`Clickthrough: ${enabled ? "ON" : "OFF"}`);
});

toggleSettingsButton.addEventListener("click", async () => {
  await window.controlApi.toggleOverlayPanel();
  await refreshStatus();
});

void refreshStatus();
