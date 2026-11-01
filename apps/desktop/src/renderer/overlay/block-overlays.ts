import type { CaptureMode, DesktopRect, DesktopTranslationResult, OverlaySettings, OverlayViewport, TranslationBlock } from '../../shared/types';

type OverlayCard = Pick<TranslationBlock, 'id' | 'text' | 'translatedText' | 'bounds' | 'readingOrder'>;

export function overlayCards(result: DesktopTranslationResult, mode: CaptureMode): OverlayCard[] {
  if (mode === 'multiple_regions') return [{
    id: result.regionId, text: result.combinedSourceText, translatedText: result.combinedTranslatedText,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, readingOrder: 0,
  }];
  return [...result.blocks].sort((a, b) => a.readingOrder - b.readingOrder);
}

export function projectBlock(bounds: DesktopRect, capture: DesktopRect): DesktopRect {
  return { x: capture.x + bounds.x * capture.width, y: capture.y + bounds.y * capture.height,
    width: bounds.width * capture.width, height: bounds.height * capture.height };
}

export function placeBlock(anchor: DesktopRect, size: { width: number; height: number }, area: DesktopRect) {
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, Math.max(lo, hi)));
  let y = anchor.y + anchor.height;
  if (y + size.height > area.y + area.height) y = anchor.y - size.height;
  return {
    x: clamp(anchor.x, area.x, area.x + area.width - size.width),
    y: clamp(y, area.y, area.y + area.height - size.height),
  };
}

type RegionOverlay = { result: DesktopTranslationResult; cards: OverlayCard[]; nodes: HTMLElement[]; timer?: ReturnType<typeof setTimeout> };

export class BlockOverlays {
  private regions = new Map<string, RegionOverlay>();
  private settings?: OverlaySettings;
  private viewport?: OverlayViewport;
  private observer = new ResizeObserver(() => this.layout());

  constructor(private readonly container: HTMLElement) {}

  configure(settings: OverlaySettings, viewport: OverlayViewport): void {
    this.settings = settings;
    this.viewport = viewport;
    this.layout();
  }

  show(result: DesktopTranslationResult): void {
    const previous = this.regions.get(result.regionId);
    if (previous?.result.sessionId === result.sessionId && BigInt(result.frameId) <= BigInt(previous.result.frameId)) return;
    this.remove(result.regionId);
    const cards = overlayCards(result, this.settings?.mode ?? 'selected_window');
    const nodes = cards.map((block) => {
      const card = document.createElement('div');
      card.className = 'block-overlay';
      card.dataset.blockId = block.id;
      card.dataset.regionId = result.regionId;
      const source = document.createElement('div');
      source.className = 'line block-source';
      source.textContent = block.text.trim();
      const translation = document.createElement('div');
      translation.className = 'line block-translation';
      translation.textContent = block.translatedText.trim();
      card.append(source, translation);
      this.container.append(card);
      this.observer.observe(card);
      return card;
    });
    const region: RegionOverlay = { result, cards, nodes };
    if (this.settings && this.settings.autoHideMs >= 0) {
      region.timer = setTimeout(() => nodes.forEach((node) => { node.hidden = true; }), this.settings.autoHideMs);
    }
    this.regions.set(result.regionId, region);
    this.layout();
  }

  move(regionId: string, captureBounds: DesktopRect): void {
    const region = this.regions.get(regionId);
    if (!region) return;
    region.result.captureBounds = captureBounds;
    this.layout();
  }

  clear(regionId: string, sessionId: string, frameId: string): void {
    const current = this.regions.get(regionId);
    if (current?.result.sessionId === sessionId && BigInt(frameId) >= BigInt(current.result.frameId)) this.remove(regionId);
  }

  private remove(regionId: string): void {
    const region = this.regions.get(regionId);
    if (!region) return;
    clearTimeout(region.timer);
    region.nodes.forEach((node) => { this.observer.unobserve(node); node.remove(); });
    this.regions.delete(regionId);
  }

  private layout(): void {
    if (!this.settings || !this.viewport) return;
    const { bounds, workArea } = this.viewport;
    for (const { result, cards, nodes } of this.regions.values()) {
      nodes.forEach((node, index) => {
        const card = cards[index];
        const visibleText = (this.settings!.showSource && this.settings!.sourceFontSize !== 0 && card.text.trim())
          || (this.settings!.translatedFontSize !== 0 && card.translatedText.trim());
        node.style.display = visibleText ? '' : 'none';
        if (!visibleText) return;
        if (!result.captureBounds) { node.style.visibility = 'hidden'; return; }
        const anchor = projectBlock(cards[index].bounds, result.captureBounds);
        const cx = anchor.x + anchor.width / 2, cy = anchor.y + anchor.height / 2;
        if (cx < bounds.x || cy < bounds.y || cx >= bounds.x + bounds.width || cy >= bounds.y + bounds.height) {
          node.style.visibility = 'hidden'; return;
        }
        node.style.visibility = 'visible';
        const matchArea = this.settings!.mode === 'multiple_regions';
        node.style.width = matchArea ? `${Math.min(anchor.width, workArea.width)}px` : '';
        node.style.maxWidth = `${matchArea ? workArea.width : Math.min(this.settings!.width, workArea.width)}px`;
        node.style.maxHeight = `${workArea.height}px`;
        const position = placeBlock(anchor, node.getBoundingClientRect(), workArea);
        node.style.left = `${position.x - bounds.x}px`;
        node.style.top = `${position.y - bounds.y}px`;
      });
    }
  }
}
