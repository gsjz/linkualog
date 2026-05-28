import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QUEUE_COUNT_EVENT, QUEUE_REQUEST_COUNT_EVENT, QUEUE_TOGGLE_EVENT } from './VocabQueue';
import { ConfigService } from '../services/configService';

interface UniversalVocabWidgetProps {
  onOpenSettings: () => void;
}

type SendStatus = 'idle' | 'filled' | 'success' | 'error';
type SelectionMode = 'word' | 'context';
type WidgetIcon = 'add' | 'queue' | 'settings' | 'collapse';

interface SelectionCapture {
  text: string;
  context: string;
  source: string;
  url: string;
  top: number;
  left: number;
}

const DESKTOP_WIDGET_HEIGHT = 58;
const MOBILE_WIDGET_HEIGHT = 132;
const COLLAPSED_WIDGET_HEIGHT = 28;
const WIDGET_VIEWPORT_MARGIN = 8;
const MAX_WORD_SELECTION_LENGTH = 180;
const MAX_CONTEXT_SELECTION_LENGTH = 4000;
const CONTEXT_SENTENCE_RADIUS = 2;
const SENTENCE_PATTERN = /[^.!?。！？]+[.!?。！？]+["'”’）)]*|[^.!?。！？]+$/g;
const VIEWPORT_PATCH_MARKER = '__linkualUniversalViewportPatchInstalled';
const VIEWPORT_OFFSET_KEY = '__linkualUniversalWidgetHeight';
const PAGE_RESERVE_STYLE_ID = 'linkual-universal-page-reserve';
const LINKUAL_NAVIGATION_EVENT = 'linkual_navigation';
const FLOATING_BUTTON_MARGIN = 10;

const getDefaultExpandedHeight = () => (
  window.matchMedia('(max-width: 720px)').matches ? MOBILE_WIDGET_HEIGHT : DESKTOP_WIDGET_HEIGHT
);

const isOwnViewportGetterPatched = (target: object | null | undefined, marker: string) => Boolean(
  target && (target as Record<string, unknown>)[marker]
);

const getVisualViewportHeight = () => {
  const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
  const reservedOffset = (
    isOwnViewportGetterPatched(window.visualViewport, '__linkualVisualViewportHeightPatched')
    || isOwnViewportGetterPatched(window, '__linkualInnerHeightPatched')
  ) ? getViewportOffset() : 0;
  const rawHeight = Number(viewportHeight) + reservedOffset;
  return Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : getDefaultExpandedHeight();
};

const getMaxWidgetHeight = () => Math.max(
  COLLAPSED_WIDGET_HEIGHT,
  Math.floor(getVisualViewportHeight() - WIDGET_VIEWPORT_MARGIN)
);

const syncVisualViewportHeightProperty = () => {
  document.documentElement.style.setProperty('--linkual-visual-viewport-height', `${Math.ceil(getVisualViewportHeight())}px`);
};

const ActionIcon: React.FC<{ name: WidgetIcon }> = ({ name }) => {
  const paths: Record<WidgetIcon, React.ReactNode> = {
    add: (
      <>
        <path d="M4 7.5h5l2 2h9v8.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
        <path d="M12 12v5" />
        <path d="M9.5 14.5h5" />
      </>
    ),
    queue: (
      <>
        <path d="M8 6h12" />
        <path d="M8 12h12" />
        <path d="M8 18h12" />
        <path d="M4 6h.01" />
        <path d="M4 12h.01" />
        <path d="M4 18h.01" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.04.04a2 2 0 1 1-2.83 2.83l-.04-.04a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.07a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.04.04a2 2 0 1 1-2.83-2.83l.04-.04A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 14H3a2 2 0 1 1 0-4h.07A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.04-.04a2 2 0 1 1 2.83-2.83l.04.04A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.07A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.04-.04a2 2 0 1 1 2.83 2.83l-.04.04A1.7 1.7 0 0 0 19.4 9c.17.62.7 1 1.6 1H21a2 2 0 1 1 0 4h-.07a1.7 1.7 0 0 0-1.53 1Z" />
      </>
    ),
    collapse: <path d="m6 9 6 6 6-6" />,
  };

  return (
    <svg className="linkual-universal-button-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
};

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

const getSourceTitle = () => {
  const title = normalizeText(document.title.replace(/^\(\d+\)\s+/, ''));
  return title || window.location.hostname || window.location.href;
};

const getPageUrl = () => window.location.href;

const getElementFromNode = (node: Node | null) => {
  if (!node) return null;
  if (node instanceof Element) return node;
  return node.parentElement;
};

const isInsideLinkualRoot = (node: Node | null) => {
  const element = getElementFromNode(node);
  return Boolean(element?.closest('#linkual-root'));
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
    if (element.id === 'linkual-root') return null;

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
  } catch (err) {
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
    viewportLeft + viewportWidth - 44,
    Math.max(viewportLeft + 44, rect.left + rect.width / 2)
  );

  let top = rect.top - 38;
  if (top < viewportTop + FLOATING_BUTTON_MARGIN) {
    top = rect.bottom + 8;
  }

  return {
    left,
    top: Math.min(
      viewportTop + viewportHeight - 38,
      Math.max(viewportTop + FLOATING_BUTTON_MARGIN, top)
    ),
  };
};

const captureSelection = (mode: SelectionMode): SelectionCapture | null => {
  const selection = window.getSelection();
  const selectedText = normalizeText(selection?.toString() || '');

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selectedText) {
    return null;
  }

  const maxSelectionLength = mode === 'word' ? MAX_WORD_SELECTION_LENGTH : MAX_CONTEXT_SELECTION_LENGTH;
  if (selectedText.length > maxSelectionLength) {
    return null;
  }

  if (
    isInsideLinkualRoot(selection.anchorNode)
    || isInsideLinkualRoot(selection.focusNode)
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
    context: mode === 'word' ? extractSentenceContext(beforeText, selectedText, afterText) : selectedText,
    source: getSourceTitle(),
    url: getPageUrl(),
    top: position.top,
    left: position.left,
  };
};

const getPageWindow = () => {
  try {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  } catch {
    return window;
  }
};

const findPropertyDescriptor = (target: object | null, property: string): PropertyDescriptor | undefined => {
  let cursor = target;
  while (cursor) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
    if (descriptor) return descriptor;
    cursor = Object.getPrototypeOf(cursor);
  }
  return undefined;
};

const getViewportOffset = () => {
  const pageWindow = getPageWindow() as Window & typeof globalThis & Record<string, unknown>;
  const raw = Number(pageWindow[VIEWPORT_OFFSET_KEY] || 0);
  return Number.isFinite(raw) ? raw : 0;
};

const patchNumericHeightGetter = (target: object | null, property: string, marker: string) => {
  if (!target || (target as Record<string, unknown>)[marker]) return;

  const descriptor = findPropertyDescriptor(target, property);
  if (!descriptor?.get) return;

  try {
    Object.defineProperty(target, property, {
      configurable: true,
      get() {
        const value = Number(descriptor.get?.call(this) || 0);
        return Math.max(0, value - getViewportOffset());
      },
    });
    (target as Record<string, unknown>)[marker] = true;
  } catch {}
};

const patchDocumentViewportElements = () => {
  patchNumericHeightGetter(document.documentElement, 'clientHeight', '__linkualClientHeightPatched');
  patchNumericHeightGetter(document.body, 'clientHeight', '__linkualClientHeightPatched');
};

const installViewportHeightPatch = () => {
  const pageWindow = getPageWindow() as Window & typeof globalThis & Record<string, unknown>;

  if (!pageWindow[VIEWPORT_PATCH_MARKER]) {
    patchNumericHeightGetter(pageWindow, 'innerHeight', '__linkualInnerHeightPatched');
    patchNumericHeightGetter(pageWindow.visualViewport, 'height', '__linkualVisualViewportHeightPatched');
    pageWindow[VIEWPORT_PATCH_MARKER] = true;
  }

  patchDocumentViewportElements();
};

const ensurePageReserveStyle = () => {
  let styleEl = document.getElementById(PAGE_RESERVE_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = PAGE_RESERVE_STYLE_ID;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = `
    html.linkual-universal-widget-open {
      --linkual-page-bottom-reserve: calc(var(--linkual-universal-widget-height, ${COLLAPSED_WIDGET_HEIGHT}px) + env(safe-area-inset-bottom, 0px));
      --linkual-page-height: calc(var(--linkual-visual-viewport-height, 100vh) - var(--linkual-page-bottom-reserve));
      scroll-padding-bottom: var(--linkual-page-bottom-reserve) !important;
    }
    html.linkual-universal-widget-open,
    html.linkual-universal-widget-open body {
      min-height: var(--linkual-page-height) !important;
    }
    html.linkual-universal-widget-open body {
      padding-bottom: var(--linkual-page-bottom-reserve) !important;
      box-sizing: border-box !important;
    }
    html.linkual-universal-widget-open [data-linkual-root="true"] {
      padding-bottom: 0 !important;
    }
  `;
};

const dispatchViewportResize = () => {
  const pageWindow = getPageWindow() as Window & typeof globalThis;
  const PageEvent = pageWindow.Event || Event;

  const dispatch = () => {
    window.dispatchEvent(new Event('resize'));
    if (pageWindow !== window) {
      pageWindow.dispatchEvent(new PageEvent('resize'));
    }
    pageWindow.visualViewport?.dispatchEvent(new PageEvent('resize'));
  };

  dispatch();
  window.requestAnimationFrame(dispatch);
  window.setTimeout(dispatch, 120);
};

const applyPageReserve = (height: number) => {
  const nextHeight = Math.max(0, Math.ceil(height));
  const pageWindow = getPageWindow() as Window & typeof globalThis & Record<string, unknown>;

  installViewportHeightPatch();
  ensurePageReserveStyle();
  patchDocumentViewportElements();

  pageWindow[VIEWPORT_OFFSET_KEY] = nextHeight;
  syncVisualViewportHeightProperty();
  document.documentElement.style.setProperty('--linkual-universal-widget-height', `${nextHeight}px`);
  document.documentElement.classList.add('linkual-universal-widget-open');
  dispatchViewportResize();
};

const releasePageReserve = () => {
  const pageWindow = getPageWindow() as Window & typeof globalThis & Record<string, unknown>;

  document.documentElement.classList.remove('linkual-universal-widget-open');
  document.documentElement.style.removeProperty('--linkual-universal-widget-height');
  document.documentElement.style.removeProperty('--linkual-visual-viewport-height');
  pageWindow[VIEWPORT_OFFSET_KEY] = 0;
  dispatchViewportResize();
};

const UniversalVocabWidget: React.FC<UniversalVocabWidgetProps> = ({ onOpenSettings }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selection, setSelection] = useState<SelectionCapture | null>(null);
  const [word, setWord] = useState('');
  const [context, setContext] = useState('');
  const [source, setSource] = useState('');
  const [sourceUrl, setSourceUrl] = useState(getPageUrl);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('word');
  const [themeColor, setThemeColor] = useState(ConfigService.get('theme_color') as string || '#000000');
  const [status, setStatus] = useState<SendStatus>('idle');
  const [message, setMessage] = useState('');
  const [reservedHeight, setReservedHeight] = useState(getDefaultExpandedHeight);
  const [queueCount, setQueueCount] = useState(0);

  const widgetRef = useRef<HTMLDivElement | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const activeWidgetHeight = isExpanded ? reservedHeight : COLLAPSED_WIDGET_HEIGHT;

  const hasPayload = Boolean(word.trim());
  const canSend = hasPayload;

  const statusText = useMemo(() => {
    if (status === 'success') return message || '已加入队列';
    if (status === 'error') return message || '加入失败';
    if (status === 'filled') return '已填入';
    return '';
  }, [message, status]);

  const measureWidgetHeight = useCallback(() => {
    const baseHeight = getDefaultExpandedHeight();
    const measuredHeight = widgetRef.current ? Math.ceil(widgetRef.current.scrollHeight) : 0;
    const nextHeight = Math.min(getMaxWidgetHeight(), Math.max(baseHeight, measuredHeight));

    setReservedHeight((currentHeight) => (
      Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight
    ));
  }, []);

  useEffect(() => {
    const updateReservedHeight = () => {
      syncVisualViewportHeightProperty();
      setReservedHeight(Math.min(getDefaultExpandedHeight(), getMaxWidgetHeight()));
      window.requestAnimationFrame(measureWidgetHeight);
    };

    updateReservedHeight();
    const desktopQuery = window.matchMedia('(max-width: 720px)');
    desktopQuery.addEventListener('change', updateReservedHeight);
    window.visualViewport?.addEventListener('resize', updateReservedHeight);
    return () => {
      desktopQuery.removeEventListener('change', updateReservedHeight);
      window.visualViewport?.removeEventListener('resize', updateReservedHeight);
    };
  }, [measureWidgetHeight]);

  useEffect(() => {
    if (!isExpanded) return undefined;

    const frameId = window.requestAnimationFrame(measureWidgetHeight);
    return () => window.cancelAnimationFrame(frameId);
  });

  useEffect(() => {
    const handleConfigUpdate = () => {
      setThemeColor(ConfigService.get('theme_color') as string || '#000000');
    };

    window.addEventListener('linkual_settings_updated', handleConfigUpdate);
    return () => window.removeEventListener('linkual_settings_updated', handleConfigUpdate);
  }, []);

  useEffect(() => {
    const updateQueueCount = (event: Event) => {
      const detail = (event as CustomEvent<{ pendingCount?: number }>).detail;
      const nextCount = Number(detail?.pendingCount || 0);
      setQueueCount(Number.isFinite(nextCount) ? nextCount : 0);
    };

    window.addEventListener(QUEUE_COUNT_EVENT, updateQueueCount);
    window.dispatchEvent(new Event(QUEUE_REQUEST_COUNT_EVENT));

    return () => window.removeEventListener(QUEUE_COUNT_EVENT, updateQueueCount);
  }, []);

  useEffect(() => releasePageReserve, []);

  useEffect(() => {
    applyPageReserve(activeWidgetHeight);
  }, [activeWidgetHeight]);

  useEffect(() => {
    const handleNavigationRefresh = () => {
      setSelection(null);
      setSourceUrl(getPageUrl());

      window.requestAnimationFrame(() => {
        if (isExpanded) measureWidgetHeight();
        applyPageReserve(activeWidgetHeight);
      });
    };

    window.addEventListener(LINKUAL_NAVIGATION_EVENT, handleNavigationRefresh);
    window.addEventListener('pageshow', handleNavigationRefresh);
    return () => {
      window.removeEventListener(LINKUAL_NAVIGATION_EVENT, handleNavigationRefresh);
      window.removeEventListener('pageshow', handleNavigationRefresh);
    };
  }, [activeWidgetHeight, isExpanded, measureWidgetHeight]);

  const refreshSelection = useCallback(() => {
    if (!isExpanded) return;
    setSelection(captureSelection(selectionMode));
  }, [isExpanded, selectionMode]);

  const scheduleSelectionRefresh = useCallback((delay = 80) => {
    if (!isExpanded) return;
    if (selectionTimerRef.current !== null) {
      window.clearTimeout(selectionTimerRef.current);
    }

    selectionTimerRef.current = window.setTimeout(() => {
      selectionTimerRef.current = null;
      refreshSelection();
    }, delay);
  }, [isExpanded, refreshSelection]);

  useEffect(() => {
    if (!isExpanded) return undefined;

    const handleSelectionChange = () => scheduleSelectionRefresh(90);
    const handlePointerUp = () => scheduleSelectionRefresh(20);
    const handleKeyUp = () => scheduleSelectionRefresh(20);

    document.addEventListener('selectionchange', handleSelectionChange);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('keyup', handleKeyUp, true);

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      if (selectionTimerRef.current !== null) {
        window.clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = null;
      }
    };
  }, [isExpanded, scheduleSelectionRefresh]);

  const handleAddSelection = () => {
    if (!selection) return;

    if (selectionMode === 'word') {
      setWord(selection.text);
      setContext(selection.context);
      setSelectionMode('context');
    } else {
      setContext(selection.text);
    }

    setSource(selection.source);
    setSourceUrl(selection.url);
    setStatus('filled');
    setMessage('');
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleClear = () => {
    setWord('');
    setContext('');
    setSource('');
    setSourceUrl(getPageUrl());
    setStatus('idle');
    setMessage('');
    setSelection(null);
    setSelectionMode('word');
  };

  const handleAddToQueue = () => {
    const finalWord = word.trim();
    const finalContext = context.trim();

    if (!finalWord) {
      setStatus('error');
      setMessage('词块不能为空');
      return;
    }

    window.dispatchEvent(new CustomEvent('linkual-add-vocab', {
      detail: {
        word: finalWord,
        context: finalContext,
        source: source || getSourceTitle(),
        source_url: sourceUrl || getPageUrl(),
      },
    }));
    window.dispatchEvent(new Event(QUEUE_REQUEST_COUNT_EVENT));

    setStatus('success');
    setMessage('已加入队列');
    setSelectionMode('word');
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleModeChange = (mode: SelectionMode) => {
    setSelectionMode(mode);
    setMessage('');
    window.setTimeout(() => setSelection(captureSelection(mode)), 0);
  };

  const handleContextWheel = (event: React.WheelEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const maxScroll = input.scrollWidth - input.clientWidth;
    if (maxScroll <= 0) return;

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;

    const nextScroll = Math.max(0, Math.min(maxScroll, input.scrollLeft + delta));
    if (nextScroll !== input.scrollLeft) {
      event.preventDefault();
      input.scrollLeft = nextScroll;
    }
  };

  const handleQueueToggle = () => {
    window.dispatchEvent(new Event(QUEUE_TOGGLE_EVENT));
    window.dispatchEvent(new Event(QUEUE_REQUEST_COUNT_EVENT));
  };

  if (!isExpanded) {
    return (
      <button
        type="button"
        className="linkual-universal-expand-bar"
        onClick={() => setIsExpanded(true)}
        style={{
          '--linkual-theme': themeColor,
        } as React.CSSProperties}
        title="Linkual"
      >
        展开选词栏
      </button>
    );
  }

  return (
    <div
      ref={widgetRef}
      className="linkual-universal-widget"
      style={{
        '--linkual-theme': themeColor,
        '--linkual-universal-widget-height': `${reservedHeight}px`,
      } as React.CSSProperties}
    >
      {selection && (
        <button
          type="button"
          className="linkual-universal-floating-add"
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={(event) => event.preventDefault()}
          onClick={handleAddSelection}
          style={{
            top: selection.top,
            left: selection.left,
            '--linkual-theme': themeColor,
          } as React.CSSProperties}
        >
          加入
        </button>
      )}

      <div className="linkual-universal-top">
        <div className="linkual-universal-selection">
          {selection ? (
            <>
              <span className="linkual-universal-selection-label">已选</span>
              <span className="linkual-universal-selection-text">{selection.text}</span>
              <button
                type="button"
                className="linkual-universal-add-btn"
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={(event) => event.preventDefault()}
                onClick={handleAddSelection}
              >
                加入
              </button>
            </>
          ) : (
            <span className="linkual-universal-muted">未选中文本</span>
          )}
        </div>

        <div className="linkual-universal-actions">
          {statusText && <span className={`linkual-universal-status status-${status}`}>{statusText}</span>}
        </div>
      </div>

      <div className="linkual-universal-form">
        <label className="linkual-universal-field field-word">
          <button
            type="button"
            className={`linkual-universal-mode-tab ${selectionMode === 'word' ? 'active' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => handleModeChange('word')}
          >
            词块
          </button>
          <input
            value={word}
            onChange={(event) => {
              setWord(event.target.value);
              setStatus(event.target.value.trim() ? 'filled' : 'idle');
              setMessage('');
            }}
            placeholder="word or phrase"
          />
        </label>

        <label className="linkual-universal-field field-context">
          <button
            type="button"
            className={`linkual-universal-mode-tab ${selectionMode === 'context' ? 'active' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => handleModeChange('context')}
          >
            上下文
          </button>
          <input
            value={context}
            onChange={(event) => {
              setContext(event.target.value);
              if (word.trim()) setStatus('filled');
              setMessage('');
            }}
            onWheel={handleContextWheel}
            placeholder="context"
          />
        </label>

        <button type="button" className="linkual-universal-clear" onClick={handleClear} disabled={!hasPayload && !context}>
          x
        </button>

        <button type="button" className="linkual-universal-send" onClick={handleAddToQueue} disabled={!canSend} title="加入队列" aria-label="加入队列">
          <ActionIcon name="add" />
          <span className="linkual-universal-button-text">加入队列</span>
        </button>

        <div className="linkual-universal-inline-actions">
          <button type="button" className="linkual-universal-icon-btn linkual-universal-queue-btn" onClick={handleQueueToggle} title="制卡队列" aria-label={`制卡队列${queueCount > 0 ? ` ${queueCount}` : ''}`}>
            <ActionIcon name="queue" />
            <span className="linkual-universal-button-text">制卡队列</span>
            {queueCount > 0 && <span className="linkual-universal-queue-count">{queueCount}</span>}
          </button>
          <button type="button" className="linkual-universal-icon-btn" onClick={onOpenSettings} title="设置" aria-label="设置">
            <ActionIcon name="settings" />
            <span className="linkual-universal-button-text">设置</span>
          </button>
          <button type="button" className="linkual-universal-icon-btn" onClick={() => setIsExpanded(false)} title="折叠" aria-label="收起">
            <ActionIcon name="collapse" />
            <span className="linkual-universal-button-text">收起</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default UniversalVocabWidget;
