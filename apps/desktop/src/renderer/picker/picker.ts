import type { CaptureRegion } from '../../shared/types';

const hint = document.getElementById('hint')!;
const selection = document.getElementById('selection')!;
const coords = document.getElementById('coords')!;
const saved = document.getElementById('saved-regions')!;
const toolbar = document.getElementById('toolbar')!;
const count = document.getElementById('region-count')!;
const apply = document.getElementById('apply') as HTMLButtonElement;
const undo = document.getElementById('undo') as HTMLButtonElement;
const clear = document.getElementById('clear') as HTMLButtonElement;

let mode: 'choose' | 'drag' = 'choose';
let multiple = false;
let busy = false;
let dragging = false;
let startX = 0, startY = 0, originX = 0, originY = 0;
let captureScaleFactor = 1;
let otherRegionCount = 0;
let regions: CaptureRegion[] = [];

function drawRect(x1: number, y1: number, x2: number, y2: number): CaptureRegion {
  x2 = Math.max(0, Math.min(window.innerWidth, x2));
  y2 = Math.max(0, Math.min(window.innerHeight, y2));
  const region = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  selection.style.display = 'block';
  Object.assign(selection.style, { left: `${region.left}px`, top: `${region.top}px`, width: `${region.width}px`, height: `${region.height}px` });
  coords.style.display = 'block';
  coords.style.left = `${Math.min(x2 + 14, Math.max(0, window.innerWidth - 260))}px`;
  coords.style.top = `${Math.min(y2 + 14, Math.max(0, window.innerHeight - 36))}px`;
  coords.textContent = `x:${Math.round(region.left)} y:${Math.round(region.top)} w:${Math.round(region.width)} h:${Math.round(region.height)}`;
  return region;
}

function renderDraft(): void {
  saved.replaceChildren();
  regions.forEach((region, index) => {
    const rect = document.createElement('div');
    rect.className = 'saved-region';
    Object.assign(rect.style, { left: `${region.left}px`, top: `${region.top}px`, width: `${region.width}px`, height: `${region.height}px` });
    const label = document.createElement('span');
    label.textContent = String(index + 1);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.disabled = busy;
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove region ${index + 1}`);
    remove.setAttribute('data-picker-control', '');
    remove.addEventListener('click', () => { regions.splice(index, 1); renderDraft(); });
    rect.append(label, remove);
    saved.append(rect);
  });
  count.textContent = `${regions.length} on this screen${otherRegionCount ? ` · ${otherRegionCount} on other screens` : ''}`;
  undo.disabled = clear.disabled = busy || !regions.length;
  apply.disabled = busy || !(regions.length + otherRegionCount);
}

function toCapture(region: CaptureRegion): CaptureRegion {
  return { left: Math.round((originX + region.left) * captureScaleFactor), top: Math.round((originY + region.top) * captureScaleFactor),
    width: Math.round(region.width * captureScaleFactor), height: Math.round(region.height * captureScaleFactor) };
}

async function submit(value: CaptureRegion | CaptureRegion[]): Promise<void> {
  if (busy) return;
  busy = true;
  renderDraft();
  try {
    const response = await window.pickerApi.submit(value);
    if (response.status !== 'ok') throw new Error('Select at least one valid area inside this screen.');
  } catch (error) {
    hint.textContent = error instanceof Error ? error.message : String(error);
  } finally { busy = false; renderDraft(); }
}

function confirm(): void {
  if (mode !== 'drag' || !multiple || dragging || apply.disabled) return;
  void submit(regions.map(toCapture));
}

document.addEventListener('click', (event: MouseEvent) => {
  if (event.button === 0 && mode === 'choose') window.pickerApi.select();
});

window.pickerApi.onStartDrag((payload) => {
  mode = 'drag';
  originX = payload.originX;
  originY = payload.originY;
  captureScaleFactor = payload.captureScaleFactor;
  multiple = payload.multiple;
  otherRegionCount = payload.otherRegionCount;
  regions = payload.regions.map((r) => ({ left: r.left / captureScaleFactor - originX, top: r.top / captureScaleFactor - originY,
    width: r.width / captureScaleFactor, height: r.height / captureScaleFactor }));
  document.body.classList.add('drag-mode');
  toolbar.hidden = !multiple;
  hint.textContent = multiple
    ? 'Drag to add areas. Enter or Apply regions to save. Esc or right-click to cancel.'
    : 'Drag to select region. Release mouse to confirm. Esc or right-click to cancel.';
  renderDraft();
});

document.addEventListener('mousedown', (event: MouseEvent) => {
  if (mode !== 'drag' || busy || event.button !== 0 || (event.target as Element).closest('[data-picker-control]')) return;
  dragging = true;
  startX = event.clientX;
  startY = event.clientY;
  drawRect(startX, startY, startX, startY);
});
document.addEventListener('mousemove', (event: MouseEvent) => {
  if (dragging) drawRect(startX, startY, event.clientX, event.clientY);
});
document.addEventListener('mouseup', (event: MouseEvent) => {
  if (!dragging || event.button !== 0) return;
  dragging = false;
  const region = drawRect(startX, startY, event.clientX, event.clientY);
  selection.style.display = coords.style.display = 'none';
  if (region.width < 20 || region.height < 20) return;
  if (multiple) {
    if (!regions.some((r) => JSON.stringify(toCapture(r)) === JSON.stringify(toCapture(region)))) regions.push(region);
    renderDraft();
  } else void submit(toCapture(region));
});

apply.addEventListener('click', confirm);
undo.addEventListener('click', () => { regions.pop(); renderDraft(); });
clear.addEventListener('click', () => { regions = []; renderDraft(); });
document.getElementById('cancel')!.addEventListener('click', () => { void window.pickerApi.cancel(); });
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') void window.pickerApi.cancel();
  if (event.key === 'Enter') { event.preventDefault(); confirm(); }
  if (multiple && !busy && !dragging && (event.key === 'Backspace' || event.key === 'Delete')) {
    event.preventDefault(); regions.pop(); renderDraft();
  }
});
document.addEventListener('contextmenu', (event: MouseEvent) => {
  event.preventDefault(); void window.pickerApi.cancel();
});
