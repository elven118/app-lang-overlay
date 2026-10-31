import type { WindowHover } from '../../shared/types';

const highlight = document.getElementById('highlight')!;
const title = document.getElementById('title')!;
const message = document.getElementById('message')!;

function render(state: WindowHover): void {
  highlight.hidden = !state.bounds;
  title.textContent = state.name;
  message.textContent = state.error || (state.bounds
    ? 'Click to capture this window · Esc or right-click to cancel'
    : 'Hover over a window to select it · Esc or right-click to cancel');
  if (state.bounds) {
    const b = state.bounds;
    highlight.style.left = `${b.x}px`;
    highlight.style.top = `${b.y}px`;
    highlight.style.width = `${b.width}px`;
    highlight.style.height = `${b.height}px`;
  }
}

window.windowPickerApi.onHover(render);
void window.windowPickerApi.getState().then(render);
document.addEventListener('click', () => { void window.windowPickerApi.select(); });
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  void window.windowPickerApi.cancel();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void window.windowPickerApi.cancel();
});
