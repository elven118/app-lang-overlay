import type { ProfileState } from '../../shared/types';

const statusLine = document.getElementById("status-line") as HTMLParagraphElement;
const profileSelect = document.getElementById("profile-select") as HTMLSelectElement;
const profileNameInput = document.getElementById("profile-name") as HTMLInputElement;
const profileMessage = document.getElementById("profile-message") as HTMLParagraphElement;
const loadProfileButton = document.getElementById("btn-load-profile") as HTMLButtonElement;
const createProfileButton = document.getElementById("btn-create-profile") as HTMLButtonElement;
const renameProfileButton = document.getElementById("btn-rename-profile") as HTMLButtonElement;
const pickRegionButton = document.getElementById("btn-pick-region") as HTMLButtonElement;
const togglePauseButton = document.getElementById("btn-toggle-pause") as HTMLButtonElement;
const showTranscriptButton = document.getElementById("btn-show-transcript") as HTMLButtonElement;
const toggleSettingsButton = document.getElementById("btn-toggle-settings") as HTMLButtonElement;

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function setProfileMessage(text: string, error = false): void {
  profileMessage.textContent = text;
  profileMessage.classList.toggle('error', error);
}

function renderProfiles(state: ProfileState): void {
  profileSelect.replaceChildren();
  for (const profileId of state.profiles) {
    const option = document.createElement('option');
    option.value = profileId;
    option.textContent = profileId;
    option.selected = profileId === state.activeProfileId;
    profileSelect.append(option);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runProfileAction(action: () => Promise<ProfileState>, successMessage: string): Promise<void> {
  setProfileMessage('Saving...');
  try {
    const state = await action();
    renderProfiles(state);
    profileNameInput.value = '';
    setProfileMessage(successMessage);
    await refreshStatus();
  } catch (error) {
    setProfileMessage(errorMessage(error), true);
  }
}

async function refreshStatus(): Promise<void> {
  const [profiles, settings, status, paused] = await Promise.all([
    window.controlApi.getProfileState(),
    window.controlApi.getSettings(),
    window.controlApi.getStreamStatus(),
    window.controlApi.getPaused(),
  ]);
  renderProfiles(profiles);
  togglePauseButton.textContent = paused ? "Resume Capture" : "Pause Capture";
  pickRegionButton.textContent = settings.mode === 'selected_window' ? 'Choose Window'
    : settings.mode === 'multiple_regions' ? 'Edit Capture Regions' : 'Pick Capture Region';
  setStatus(
    `Profile: ${profiles.activeProfileId} | ${status.state}: ${status.message} | Mode: ${settings.mode} | Poll: ${settings.polling_ms} ms | OCR: ${settings.ocrLang}`,
  );
}

loadProfileButton.addEventListener('click', () => {
  const selected = profileSelect.value;
  void runProfileAction(() => window.controlApi.loadProfile(selected), `Loaded ${selected}`);
});

createProfileButton.addEventListener('click', () => {
  const nextProfileId = profileNameInput.value;
  void runProfileAction(() => window.controlApi.createProfile(nextProfileId), `Created ${nextProfileId.trim()}`);
});

renameProfileButton.addEventListener('click', () => {
  const nextProfileId = profileNameInput.value;
  void runProfileAction(() => window.controlApi.renameProfile(nextProfileId), `Renamed to ${nextProfileId.trim()}`);
});

pickRegionButton.addEventListener("click", async () => {
  setStatus("Opening capture picker...");
  await window.controlApi.pickRegion();
  await refreshStatus();
});

togglePauseButton.addEventListener("click", async () => {
  const paused = await window.controlApi.togglePause();
  togglePauseButton.textContent = paused ? "Resume Capture" : "Pause Capture";
  await refreshStatus();
});

showTranscriptButton.addEventListener("click", async () => {
  await window.controlApi.showTranscript();
});

toggleSettingsButton.addEventListener("click", async () => {
  await window.controlApi.toggleOverlayPanel();
  await refreshStatus();
});

void refreshStatus();
window.controlApi.onStreamStatus(() => {
  void refreshStatus();
});
window.controlApi.onProfileChanged((state) => {
  renderProfiles(state);
  void refreshStatus();
});
