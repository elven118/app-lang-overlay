import type { CaptureRegion } from '../../shared/types';

const hint = document.getElementById("hint") as HTMLDivElement;
const selection = document.getElementById("selection") as HTMLDivElement;
const coords = document.getElementById("coords") as HTMLDivElement;

let mode: "choose" | "drag" = "choose";
let dragging = false;
let startX = 0;
let startY = 0;
let originX = 0;
let originY = 0;
let captureScaleFactor = 1;

function drawRect(x1: number, y1: number, x2: number, y2: number): CaptureRegion {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  selection.style.display = "block";
  selection.style.left = `${left}px`;
  selection.style.top = `${top}px`;
  selection.style.width = `${width}px`;
  selection.style.height = `${height}px`;

  coords.style.display = "block";
  coords.style.left = `${x2 + 14}px`;
  coords.style.top = `${y2 + 14}px`;
  coords.textContent = `x:${Math.round(left)} y:${Math.round(top)} w:${Math.round(width)} h:${Math.round(height)}`;

  return { left, top, width, height };
}

document.addEventListener("click", () => {
  console.log("Document clicked, mode is:", mode);
  if (mode !== "choose") return;
  window.pickerApi.select();
});

window.pickerApi.onStartDrag((payload) => {
  mode = "drag";
  originX = payload?.originX ?? 0;
  originY = payload?.originY ?? 0;
  captureScaleFactor = payload?.captureScaleFactor ?? 1;
  document.body.classList.add("drag-mode");
  hint.textContent = "Drag to select region. Release mouse to confirm. ESC or right-click to cancel.";
});

document.addEventListener("mousedown", (event: MouseEvent) => {
  if (mode !== "drag" || event.button !== 0) return;
  dragging = true;
  startX = event.clientX;
  startY = event.clientY;
  drawRect(startX, startY, startX, startY);
});

document.addEventListener("mousemove", (event: MouseEvent) => {
  if (!dragging) return;
  drawRect(startX, startY, event.clientX, event.clientY);
});

document.addEventListener("mouseup", async (event: MouseEvent) => {
  if (!dragging) return;
  dragging = false;

  const localRegion = drawRect(startX, startY, event.clientX, event.clientY);
  if (localRegion.width < 20 || localRegion.height < 20) {
    selection.style.display = "none";
    coords.style.display = "none";
    return;
  }

  const absoluteRegion: CaptureRegion = {
    left: originX + localRegion.left,
    top: originY + localRegion.top,
    width: localRegion.width,
    height: localRegion.height,
  };

  // Picker works in DIPs; capture uses a precomputed scale from main.
  const captureRegion: CaptureRegion = {
    left: Math.round(absoluteRegion.left * captureScaleFactor),
    top: Math.round(absoluteRegion.top * captureScaleFactor),
    width: Math.round(absoluteRegion.width * captureScaleFactor),
    height: Math.round(absoluteRegion.height * captureScaleFactor),
  };

  await window.pickerApi.submit(captureRegion);
});

document.addEventListener("keydown", async (event: KeyboardEvent) => {
  if (event.key === "Escape") await window.pickerApi.cancel();
});

document.addEventListener("contextmenu", async (event: MouseEvent) => {
  event.preventDefault();
  await window.pickerApi.cancel();
});
