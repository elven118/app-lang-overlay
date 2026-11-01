import type { TranslationResult } from '../../shared/types';

const entries = document.getElementById('entries') as HTMLDivElement;
const emptyState = document.getElementById('empty-state') as HTMLParagraphElement;
const clearButton = document.getElementById('clear-transcript') as HTMLButtonElement;
const renderedKeys = new Set<string>();

function resultKey(result: TranslationResult): string {
  return `${result.sessionId}:${result.regionId}:${result.frameId}`;
}

function appendResult(result: TranslationResult): void {
  const key = resultKey(result);
  if (renderedKeys.has(key)) return;
  renderedKeys.add(key);
  emptyState.hidden = true;

  const article = document.createElement('article');
  article.className = 'entry';
  article.dataset.key = key;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${result.regionId} · frame ${result.frameId} · ${Math.round(result.timingMs.total)} ms`;

  const source = document.createElement('div');
  source.className = 'source';
  source.textContent = result.combinedSourceText;

  const translated = document.createElement('div');
  translated.className = 'translated';
  translated.textContent = result.combinedTranslatedText;

  article.append(meta, source, translated);
  entries.append(article);
  article.scrollIntoView({ block: 'end' });
}

clearButton.addEventListener('click', () => {
  entries.replaceChildren();
  renderedKeys.clear();
  emptyState.hidden = false;
});

window.overlayApi.onTranslationResult(appendResult);

void window.overlayApi.getTranslationHistory().then((history) => {
  history.forEach(appendResult);
});
