import { ConfigService } from '../services/configService';
import { enqueueVocabTask } from '../services/vocabQueueStore';

interface SelectionCapture {
  text: string;
  context: string;
  source: string;
  url: string;
  top: number;
  left: number;
}

const MAX_WORD_SELECTION_LENGTH = 180;
const CONTEXT_SENTENCE_RADIUS = 2;
const SENTENCE_PATTERN = /[^.!?。！？]+[.!?。！？]+["'”’）)]*|[^.!?。！？]+$/g;
const FLOATING_BUTTON_MARGIN = 10;
const BUTTON_WIDTH_ESTIMATE = 88;
const BUTTON_HEIGHT_ESTIMATE = 34;

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

const getSourceTitle = () => {
  const title = normalizeText(document.title.replace(/^\(\d+\)\s+/, ''));
  return title || window.location.hostname || window.location.href;
};

const getElementFromNode = (node: Node | null) => {
  if (!node) return null;
  if (node instanceof Element) return node;
  return node.parentElement;
};

const isInsideLinkualElement = (node: Node | null) => {
  const element = getElementFromNode(node);
  return Boolean(element?.closest('[data-linkual-quick-selection="true"], #linkual-root'));
};

const isInsideEditableElement = (node: Node | null) => {
  const element = getElementFromNode(node);
  if (!element) return false;

  return Boolean(element.closest('input, textarea, select, [contenteditable]'));
};

const getSelectionScope = (range: Range) => {
  let element = getElementFromNode(range.commonAncestorContainer);
  let fallback: HTMLElement | null = null;

  while (element && element !== document.body && element instanceof HTMLElement) {
    if (isInsideLinkualElement(element)) return null;

    const tagName = element.tagName.toLowerCase();
    const textLength = normalizeText(element.textContent || '').length;

    if (['article', 'main', 'section'].includes(tagName) || element.getAttribute('role') === 'main') {
      return element;
    }

    if (['p', 'li', 'blockquote', 'td', 'th'].includes(tagName)) {
      fallback = element;
    } else if (tagName === 'div' && textLength > 220 && textLength < 8000) {
      return element;
    }

    element = element.parentElement;
  }

  return fallback || document.body;
};

const getRangeText = (scope: Node, range: Range, side: 'before' | 'after') => {
  const scopedRange = document.createRange();
  scopedRange.selectNodeContents(scope);

  try {
    if (side === 'before') {
      scopedRange.setEnd(range.startContainer, range.startOffset);
    } else {
      scopedRange.setStart(range.endContainer, range.endOffset);
    }

    return scopedRange.toString();
  } catch {
    return '';
  } finally {
    scopedRange.detach();
  }
};

const extractSentenceContext = (beforeText: string, selectedText: string, afterText: string) => {
  const normalizedBefore = normalizeText(beforeText);
  const normalizedSelected = normalizeText(selectedText);
  const normalizedAfter = normalizeText(afterText);
  const fullText = normalizeText([normalizedBefore, normalizedSelected, normalizedAfter].filter(Boolean).join(' '));

  if (!fullText) return normalizedSelected;

  const targetStart = normalizedBefore.length + (normalizedBefore ? 1 : 0);
  const targetEnd = targetStart + normalizedSelected.length;
  const sentences = Array.from(fullText.matchAll(SENTENCE_PATTERN))
    .map((match) => ({
      text: normalizeText(match[0] || ''),
      start: match.index ?? 0,
      end: (match.index ?? 0) + (match[0] || '').length,
    }))
    .filter((sentence) => sentence.text);

  if (sentences.length === 0) {
    const sliceStart = Math.max(0, targetStart - 360);
    const sliceEnd = Math.min(fullText.length, targetEnd + 360);
    return normalizeText(fullText.slice(sliceStart, sliceEnd));
  }

  const targetSentenceIndex = sentences.findIndex((sentence) => (
    sentence.start <= targetEnd && sentence.end >= targetStart
  ));

  if (targetSentenceIndex < 0) {
    return normalizeText(fullText.slice(Math.max(0, targetStart - 360), Math.min(fullText.length, targetEnd + 360)));
  }

  const startIndex = Math.max(0, targetSentenceIndex - CONTEXT_SENTENCE_RADIUS);
  const endIndex = Math.min(sentences.length, targetSentenceIndex + CONTEXT_SENTENCE_RADIUS + 1);
  return normalizeText(sentences.slice(startIndex, endIndex).map((sentence) => sentence.text).join(' '));
};

const getVisibleRangeRect = (range: Range) => {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length > 0) return rects[0];

  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
};

const getFloatingButtonPosition = (rect: DOMRect) => {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;

  const left = Math.min(
    viewportLeft + viewportWidth - BUTTON_WIDTH_ESTIMATE / 2 - FLOATING_BUTTON_MARGIN,
    Math.max(viewportLeft + BUTTON_WIDTH_ESTIMATE / 2 + FLOATING_BUTTON_MARGIN, rect.left + rect.width / 2),
  );

  let top = rect.top - BUTTON_HEIGHT_ESTIMATE - 8;
  if (top < viewportTop + FLOATING_BUTTON_MARGIN) {
    top = rect.bottom + 8;
  }

  return {
    left,
    top: Math.min(
      viewportTop + viewportHeight - BUTTON_HEIGHT_ESTIMATE - FLOATING_BUTTON_MARGIN,
      Math.max(viewportTop + FLOATING_BUTTON_MARGIN, top),
    ),
  };
};

const captureSelection = (): SelectionCapture | null => {
  const selection = window.getSelection();
  const selectedText = normalizeText(selection?.toString() || '');

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selectedText) {
    return null;
  }

  if (selectedText.length > MAX_WORD_SELECTION_LENGTH) {
    return null;
  }

  if (
    isInsideLinkualElement(selection.anchorNode)
    || isInsideLinkualElement(selection.focusNode)
    || isInsideEditableElement(selection.anchorNode)
    || isInsideEditableElement(selection.focusNode)
  ) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const scope = getSelectionScope(range);
  if (!scope) return null;
  const rect = getVisibleRangeRect(range);
  if (!rect) return null;

  const beforeText = getRangeText(scope, range, 'before');
  const afterText = getRangeText(scope, range, 'after');
  const position = getFloatingButtonPosition(rect);

  return {
    text: selectedText,
    context: extractSentenceContext(beforeText, selectedText, afterText),
    source: getSourceTitle(),
    url: window.location.href,
    top: position.top,
    left: position.left,
  };
};

const applyButtonStyle = (button: HTMLButtonElement, selection: SelectionCapture) => {
  const themeColor = ConfigService.get('theme_color') as string || '#6a1b9a';
  button.style.cssText = [
    'all: initial',
    'position: fixed',
    `top: ${selection.top}px`,
    `left: ${selection.left}px`,
    'transform: translateX(-50%)',
    'z-index: 2147483647',
    'min-height: 30px',
    'max-width: min(180px, calc(100vw - 24px))',
    'box-sizing: border-box',
    'padding: 0 12px',
    'border: 0',
    'border-radius: 6px',
    `background: ${themeColor}`,
    'color: #fff',
    'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2)',
    'cursor: pointer',
    'font: 800 12px/30px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'white-space: nowrap',
    'text-align: center',
    'user-select: none',
    '-webkit-user-select: none',
    'pointer-events: auto',
  ].join(';');
};

export function installQuickSelectionAdd() {
  let button: HTMLButtonElement | null = null;
  let currentSelection: SelectionCapture | null = null;
  let refreshTimer: number | null = null;
  let removeTimer: number | null = null;

  const removeButton = () => {
    if (removeTimer !== null) {
      window.clearTimeout(removeTimer);
      removeTimer = null;
    }
    button?.remove();
    button = null;
    currentSelection = null;
  };

  const showButton = (selection: SelectionCapture) => {
    currentSelection = selection;
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.dataset.linkualQuickSelection = 'true';
      button.textContent = '加入生词';
      button.title = '加入 Linkual 生词队列';
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        if (!currentSelection) return;

        try {
          enqueueVocabTask({
            word: currentSelection.text,
            context: currentSelection.context,
            source: currentSelection.source,
            source_url: currentSelection.url,
          });
          button!.textContent = '已加入';
          window.getSelection()?.removeAllRanges();
          removeTimer = window.setTimeout(removeButton, 700);
        } catch (err) {
          button!.textContent = '加入失败';
          button!.title = err instanceof Error ? err.message : '加入失败';
          removeTimer = window.setTimeout(removeButton, 1200);
        }
      });
    }

    if (!button.isConnected) {
      document.body?.append(button);
    }

    button.textContent = '加入生词';
    button.title = '加入 Linkual 生词队列';
    applyButtonStyle(button, selection);
  };

  const refreshSelection = () => {
    refreshTimer = null;
    const selection = captureSelection();
    if (selection) {
      showButton(selection);
    } else if (!button?.matches(':hover')) {
      removeButton();
    }
  };

  const scheduleSelectionRefresh = (delay = 70) => {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
    }

    refreshTimer = window.setTimeout(refreshSelection, delay);
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.target instanceof Element && event.target.closest('[data-linkual-quick-selection="true"]')) return;
    removeButton();
  };

  const handleSelectionChange = () => scheduleSelectionRefresh(90);
  const handlePointerUp = () => scheduleSelectionRefresh(20);
  const handleKeyUp = () => scheduleSelectionRefresh(20);

  document.addEventListener('selectionchange', handleSelectionChange);
  window.addEventListener('pointerup', handlePointerUp, true);
  window.addEventListener('keyup', handleKeyUp, true);
  window.addEventListener('pointerdown', handlePointerDown, true);
  window.addEventListener('scroll', removeButton, true);
  window.addEventListener('pagehide', removeButton);

  return () => {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    document.removeEventListener('selectionchange', handleSelectionChange);
    window.removeEventListener('pointerup', handlePointerUp, true);
    window.removeEventListener('keyup', handleKeyUp, true);
    window.removeEventListener('pointerdown', handlePointerDown, true);
    window.removeEventListener('scroll', removeButton, true);
    window.removeEventListener('pagehide', removeButton);
    removeButton();
  };
}
