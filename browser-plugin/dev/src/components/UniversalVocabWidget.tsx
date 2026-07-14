import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfigService } from '../services/configService';
import {
  QUEUE_COUNT_EVENT,
  QUEUE_REQUEST_COUNT_EVENT,
  QUEUE_TOGGLE_EVENT,
  enqueueVocabTask,
} from '../services/vocabQueueStore';
import { useArticleTranslation } from './ArticleTranslationContext';

interface UniversalVocabWidgetProps {
  onOpenSettings: () => void;
  persistentControls: boolean;
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
const LINKUAL_NAVIGATION_EVENT = 'linkual_navigation';
const FLOATING_BUTTON_MARGIN = 10;
const BUBBLE_MARGIN = 12;
const BUBBLE_STORAGE_KEYS = ['universal_bubble_left', 'universal_bubble_top'] as const;

const getDefaultExpandedHeight = () => (
  window.matchMedia('(max-width: 720px)').matches ? MOBILE_WIDGET_HEIGHT : DESKTOP_WIDGET_HEIGHT
);

const getVisualViewportHeight = () => {
  const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
  const rawHeight = Number(viewportHeight);
  return Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : getDefaultExpandedHeight();
};

const syncVisualViewportHeightProperty = () => {
  const root = document.getElementById('linkual-root');
  if (!root) return;

  root.style.setProperty('--linkual-visual-viewport-height', `${getVisualViewportHeight()}px`);
};

const getMaxWidgetHeight = () => Math.max(
  COLLAPSED_WIDGET_HEIGHT,
  Math.floor(getVisualViewportHeight() - WIDGET_VIEWPORT_MARGIN)
);

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

const UniversalVocabWidget: React.FC<UniversalVocabWidgetProps> = ({ onOpenSettings, persistentControls }) => {
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
  const [bubblePosition, setBubblePosition] = useState<{ left: number; top: number } | null>(() => {
    const left = Number.parseFloat(ConfigService.get(BUBBLE_STORAGE_KEYS[0]) as string);
    const top = Number.parseFloat(ConfigService.get(BUBBLE_STORAGE_KEYS[1]) as string);
    return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
  });
  const [expandedPosition, setExpandedPosition] = useState<{ left: number; top: number } | null>(null);

  const widgetRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubblePositionRef = useRef(bubblePosition);
  const bubbleDragRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(null);
  const bubbleMovedRef = useRef(false);
  const expandedDragRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const articleTranslation = useArticleTranslation();
  const shouldTrackSelection = isExpanded || !persistentControls;

  const hasPayload = Boolean(word.trim());
  const canSend = hasPayload;

  const statusText = useMemo(() => {
    if (status === 'success') return message || '已加入队列';
    if (status === 'error') return message || '加入失败';
    if (status === 'filled') return '已填入';
    return '';
  }, [message, status]);

  const measureWidgetHeight = useCallback(() => {
    if (!persistentControls) return;

    const baseHeight = getDefaultExpandedHeight();
    const measuredHeight = widgetRef.current ? Math.ceil(widgetRef.current.scrollHeight) : 0;
    const nextHeight = Math.min(getMaxWidgetHeight(), Math.max(baseHeight, measuredHeight));

    setReservedHeight((currentHeight) => (
      Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight
    ));
  }, [persistentControls]);

  useEffect(() => {
    if (!persistentControls) return undefined;

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
  }, [measureWidgetHeight, persistentControls]);

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

    if (!persistentControls) return undefined;

    window.addEventListener(QUEUE_COUNT_EVENT, updateQueueCount);
    window.dispatchEvent(new Event(QUEUE_REQUEST_COUNT_EVENT));

    return () => window.removeEventListener(QUEUE_COUNT_EVENT, updateQueueCount);
  }, [persistentControls]);

  useEffect(() => {
    const handleNavigationRefresh = () => {
      setSelection(null);
      setSourceUrl(getPageUrl());

      window.requestAnimationFrame(() => {
        if (isExpanded) measureWidgetHeight();
        if (persistentControls) syncVisualViewportHeightProperty();
      });
    };

    window.addEventListener(LINKUAL_NAVIGATION_EVENT, handleNavigationRefresh);
    window.addEventListener('pageshow', handleNavigationRefresh);
    return () => {
      window.removeEventListener(LINKUAL_NAVIGATION_EVENT, handleNavigationRefresh);
      window.removeEventListener('pageshow', handleNavigationRefresh);
    };
  }, [isExpanded, measureWidgetHeight, persistentControls]);

  const refreshSelection = useCallback(() => {
    if (!shouldTrackSelection) return;
    setSelection(captureSelection(selectionMode));
  }, [selectionMode, shouldTrackSelection]);

  const scheduleSelectionRefresh = useCallback((delay = 80) => {
    if (!shouldTrackSelection) return;
    if (selectionTimerRef.current !== null) {
      window.clearTimeout(selectionTimerRef.current);
    }

    selectionTimerRef.current = window.setTimeout(() => {
      selectionTimerRef.current = null;
      refreshSelection();
    }, delay);
  }, [refreshSelection, shouldTrackSelection]);

  useEffect(() => {
    if (!shouldTrackSelection) return undefined;

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
  }, [scheduleSelectionRefresh, shouldTrackSelection]);

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

    try {
      enqueueVocabTask({
        word: finalWord,
        context: finalContext,
        source: source || getSourceTitle(),
        source_url: sourceUrl || getPageUrl(),
      });
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : '加入失败');
      return;
    }

    setStatus('success');
    setMessage('已加入队列');
    setSelectionMode('word');
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleQuickAddSelection = () => {
    if (!selection) return;

    try {
      enqueueVocabTask({
        word: selection.text,
        context: selection.context,
        source: selection.source,
        source_url: selection.url,
      });
      setStatus('success');
      setMessage('已加入队列');
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : '加入失败');
    }

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

  const clampBubblePosition = useCallback((left: number, top: number) => {
    const rect = bubbleRef.current?.getBoundingClientRect();
    const width = rect?.width || 180;
    const height = rect?.height || 44;
    const maxLeft = Math.max(BUBBLE_MARGIN, window.innerWidth - width - BUBBLE_MARGIN);
    const maxTop = Math.max(BUBBLE_MARGIN, window.innerHeight - height - BUBBLE_MARGIN);
    return {
      left: Math.max(BUBBLE_MARGIN, Math.min(left, maxLeft)),
      top: Math.max(BUBBLE_MARGIN, Math.min(top, maxTop)),
    };
  }, []);

  const handleBubblePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const rect = bubbleRef.current?.getBoundingClientRect();
    if (!rect) return;

    bubbleMovedRef.current = false;
    bubbleDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleBubblePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = bubbleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) bubbleMovedRef.current = true;
    const nextPosition = clampBubblePosition(drag.left + deltaX, drag.top + deltaY);
    bubblePositionRef.current = nextPosition;
    setBubblePosition(nextPosition);
  };

  const handleBubblePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = bubbleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const nextPosition = bubblePositionRef.current || clampBubblePosition(drag.left, drag.top);
    bubbleDragRef.current = null;
    if (bubbleMovedRef.current) {
      ConfigService.set('universal_bubble_left', String(Math.round(nextPosition.left)));
      ConfigService.set('universal_bubble_top', String(Math.round(nextPosition.top)));
    }
  };

  useEffect(() => {
    if (!bubblePosition) return undefined;

    const clampCurrentPosition = () => setBubblePosition((current) => {
      if (!current) return current;
      const nextPosition = clampBubblePosition(current.left, current.top);
      bubblePositionRef.current = nextPosition;
      return nextPosition;
    });
    clampCurrentPosition();
    window.addEventListener('resize', clampCurrentPosition);
    return () => window.removeEventListener('resize', clampCurrentPosition);
  }, [bubblePosition, clampBubblePosition]);

  const handleBubbleButtonPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleBubbleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (bubbleMovedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      bubbleMovedRef.current = false;
    }
  };

  const clampExpandedPosition = useCallback((left: number, top: number) => {
    const rect = widgetRef.current?.getBoundingClientRect();
    const width = rect?.width || Math.min(window.matchMedia('(max-width: 720px)').matches ? 420 : 600, window.innerWidth - 16);
    const height = rect?.height || Math.min(620, window.innerHeight - 16);
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
    };
  }, []);

  const handleExpandedPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest('button, input, textarea, select, [contenteditable="true"]')) return;
    const rect = widgetRef.current?.getBoundingClientRect();
    if (!rect) return;
    expandedDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleExpandedPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = expandedDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setExpandedPosition(clampExpandedPosition(
      drag.left + event.clientX - drag.startX,
      drag.top + event.clientY - drag.startY,
    ));
  };

  const persistBubblePosition = (position: { left: number; top: number }) => {
    setBubblePosition(position);
    bubblePositionRef.current = position;
    ConfigService.set('universal_bubble_left', String(Math.round(position.left)));
    ConfigService.set('universal_bubble_top', String(Math.round(position.top)));
  };

  const handleExpandedPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = expandedDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    expandedDragRef.current = null;
    const rect = widgetRef.current?.getBoundingClientRect();
    if (rect) persistBubblePosition({ left: rect.left, top: rect.top });
  };

  const handleCollapseWindow = () => {
    const rect = widgetRef.current?.getBoundingClientRect();
    if (rect) persistBubblePosition({ left: rect.left, top: rect.top });
    setIsExpanded(false);
  };

  const handleBubbleExpand = () => {
    const bubbleRect = bubbleRef.current?.getBoundingClientRect();
    if (bubbleRect) {
      const estimatedWidth = Math.min(window.matchMedia('(max-width: 720px)').matches ? 420 : 600, window.innerWidth - 16);
      const estimatedHeight = Math.min(620, window.innerHeight - 16);
      const left = Math.max(8, Math.min(bubbleRect.left, window.innerWidth - estimatedWidth - 8));
      const top = bubbleRect.top > window.innerHeight / 2
        ? Math.max(8, bubbleRect.top - estimatedHeight - 8)
        : Math.min(window.innerHeight - estimatedHeight - 8, bubbleRect.bottom + 8);
      setExpandedPosition({ left, top: Math.max(8, top) });
    }
    syncVisualViewportHeightProperty();
    setIsExpanded(true);
  };

  useEffect(() => {
    if (!persistentControls) return undefined;

    if (!isExpanded) return undefined;

    const clampExpandedPosition = () => setExpandedPosition((current) => {
      if (!current) return current;
      const rect = widgetRef.current?.getBoundingClientRect();
      const width = rect?.width || Math.min(window.matchMedia('(max-width: 720px)').matches ? 420 : 600, window.innerWidth - 16);
      const height = rect?.height || Math.min(620, window.innerHeight - 16);
      return {
        left: Math.max(8, Math.min(current.left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(current.top, window.innerHeight - height - 8)),
      };
    });
    const frameId = window.requestAnimationFrame(clampExpandedPosition);
    window.addEventListener('resize', clampExpandedPosition);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', clampExpandedPosition);
    };
  }, [isExpanded, persistentControls, reservedHeight]);

  if (!persistentControls) {
    return selection ? (
      <button
        type="button"
        className="linkual-universal-floating-add linkual-universal-quick-add"
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => event.preventDefault()}
        onClick={handleQuickAddSelection}
        style={{
          top: selection.top,
          left: selection.left,
          '--linkual-theme': themeColor,
        } as React.CSSProperties}
        title={status === 'error' ? message : '加入 Linkual 生词队列'}
      >
        加入生词
      </button>
    ) : null;
  }

  if (!isExpanded) {
    return (
      <div
        ref={bubbleRef}
        className="linkual-universal-expand-bar"
        onPointerDown={handleBubblePointerDown}
        onPointerMove={handleBubblePointerMove}
        onPointerUp={handleBubblePointerUp}
        onPointerCancel={handleBubblePointerUp}
        onClick={handleBubbleClick}
        style={{
          '--linkual-theme': themeColor,
          ...(bubblePosition ? { left: bubblePosition.left, top: bubblePosition.top, right: 'auto', bottom: 'auto' } : {}),
        } as React.CSSProperties}
        title="Linkual"
      >
        <span className="linkual-universal-bubble-grip" aria-hidden="true">⋮⋮</span>
        {articleTranslation.isPageSupported && (
          <button
            type="button"
            className="linkual-universal-bubble-translate"
            onPointerDown={handleBubbleButtonPointerDown}
            onClick={() => void articleTranslation.translateAll()}
            disabled={articleTranslation.isTranslatingAll}
            aria-label="翻译页面"
            title="翻译页面"
          >
            {articleTranslation.isTranslatingAll ? '翻译中…' : '翻译页面'}
          </button>
        )}
        <button
          type="button"
          className="linkual-universal-bubble-expand"
          onPointerDown={handleBubbleButtonPointerDown}
          onClick={handleBubbleExpand}
          title="展开 Linkual 工具栏"
          aria-label="展开 Linkual 工具栏"
        >
          <span className="linkual-universal-expand-chevron" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={widgetRef}
      className="linkual-universal-widget linkual-universal-floating-window"
      onPointerDown={handleExpandedPointerDown}
      onPointerMove={handleExpandedPointerMove}
      onPointerUp={handleExpandedPointerUp}
      onPointerCancel={handleExpandedPointerUp}
      style={{
        '--linkual-theme': themeColor,
        '--linkual-universal-widget-height': `${reservedHeight}px`,
        ...(expandedPosition ? { left: expandedPosition.left, top: expandedPosition.top, right: 'auto', bottom: 'auto' } : {}),
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

      {articleTranslation.isPageSupported && (
        <div className="linkual-universal-translation-row">
          <div className="linkual-universal-translation-summary">
            <strong>网页翻译</strong>
            <span>{articleTranslation.doneCount}/{articleTranslation.paragraphs.length} 段 · 并发 {articleTranslation.translationConcurrency}</span>
          </div>
          <div className="linkual-universal-translation-actions">
            {articleTranslation.isTranslatingAll ? (
              <button type="button" className="primary" onClick={articleTranslation.stopTranslation}>停止翻译</button>
            ) : (
              <button type="button" className="primary" onClick={() => void articleTranslation.translateAll()}>翻译页面</button>
            )}
            <button type="button" onClick={articleTranslation.rescan}>重新扫描</button>
          </div>
        </div>
      )}

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
          <button type="button" className="linkual-universal-icon-btn" onClick={handleCollapseWindow} title="折叠" aria-label="收起">
            <ActionIcon name="collapse" />
            <span className="linkual-universal-button-text">收起</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default UniversalVocabWidget;
