import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft,
  BadgePlus,
  GripVertical,
  Languages,
  ListChecks,
  PanelTopClose,
  PanelTopOpen,
  Settings as SettingsIcon,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react';
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
}

type SendStatus = 'idle' | 'filled' | 'success' | 'error';
type SelectionMode = 'word' | 'context';
type WidgetIcon = 'add' | 'queue' | 'settings' | 'expand' | 'collapse' | 'translate' | 'clear' | 'word' | 'context';

interface SelectionCapture {
  text: string;
  context: string;
  source: string;
  url: string;
  top: number;
  left: number;
}

type BubbleDockSide = 'left' | 'right';

interface BubblePosition {
  left: number;
  top: number;
  side: BubbleDockSide;
  topRatio: number;
}

interface BubbleSize {
  width: number;
  height: number;
}

interface ExpandedAnchor {
  side: BubbleDockSide;
  edge: number;
  top: number;
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
const BUBBLE_EDGE_OFFSET = 0;
const DEFAULT_BUBBLE_TOP_RATIO = 1;
const DEFAULT_BUBBLE_WIDTH = 180;
const DEFAULT_BUBBLE_HEIGHT = 44;
const LEGACY_BUBBLE_STORAGE_KEYS = ['universal_bubble_left', 'universal_bubble_top'] as const;

const getDefaultExpandedHeight = () => (
  window.matchMedia('(max-width: 720px)').matches ? MOBILE_WIDGET_HEIGHT : DESKTOP_WIDGET_HEIGHT
);

const getVisualViewportHeight = () => {
  const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
  const rawHeight = Number(viewportHeight);
  return Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : getDefaultExpandedHeight();
};

const syncVisualViewportHeightProperty = () => {
  const viewportHeight = `${getVisualViewportHeight()}px`;
  document.documentElement.style.setProperty('--linkual-visual-viewport-height', viewportHeight);

  const root = document.getElementById('linkual-root');
  if (!root) return;

  root.style.setProperty('--linkual-visual-viewport-height', viewportHeight);
};

const getMaxWidgetHeight = () => Math.max(
  COLLAPSED_WIDGET_HEIGHT,
  Math.floor(getVisualViewportHeight() - WIDGET_VIEWPORT_MARGIN)
);

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

const getViewportWidth = () => Math.max(
  DEFAULT_BUBBLE_WIDTH,
  window.innerWidth || document.documentElement.clientWidth || DEFAULT_BUBBLE_WIDTH
);

const getRightScrollbarInset = () => {
  const viewportWidth = getViewportWidth();
  const contentWidth = document.documentElement.clientWidth || viewportWidth;
  return Math.max(BUBBLE_EDGE_OFFSET, Math.ceil(viewportWidth - contentWidth));
};

const normalizeBubbleSide = (value: unknown): BubbleDockSide => (
  String(value || '').trim() === 'left' ? 'left' : 'right'
);

const normalizeBubbleTopRatio = (value: unknown, fallback = DEFAULT_BUBBLE_TOP_RATIO) => {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return clampNumber(parsed, 0, 1);
};

const getBubbleViewportBounds = (size: BubbleSize) => {
  const viewportWidth = getViewportWidth();
  const viewportHeight = Math.max(DEFAULT_BUBBLE_HEIGHT, getVisualViewportHeight());
  const rightInset = getRightScrollbarInset();
  const maxLeft = Math.max(BUBBLE_EDGE_OFFSET, viewportWidth - size.width - rightInset);
  const minTop = BUBBLE_MARGIN;
  const maxTop = Math.max(minTop, viewportHeight - size.height - BUBBLE_MARGIN);
  return { viewportWidth, viewportHeight, maxLeft, minTop, maxTop };
};

const getBubbleTopRatioFromTop = (top: number, size: BubbleSize) => {
  const bounds = getBubbleViewportBounds(size);
  if (bounds.maxTop <= bounds.minTop) return 0;
  const clampedTop = clampNumber(top, bounds.minTop, bounds.maxTop);
  return clampNumber((clampedTop - bounds.minTop) / (bounds.maxTop - bounds.minTop), 0, 1);
};

const getBubblePositionFromDock = (
  side: BubbleDockSide,
  topRatio: number,
  size: BubbleSize
): BubblePosition => {
  const bounds = getBubbleViewportBounds(size);
  const normalizedRatio = normalizeBubbleTopRatio(topRatio);
  return {
    left: side === 'left' ? BUBBLE_EDGE_OFFSET : bounds.maxLeft,
    top: bounds.minTop + (bounds.maxTop - bounds.minTop) * normalizedRatio,
    side,
    topRatio: normalizedRatio,
  };
};

const getBubblePositionFromPoint = (
  left: number,
  top: number,
  size: BubbleSize,
  preferredSide?: BubbleDockSide
): BubblePosition => {
  const bounds = getBubbleViewportBounds(size);
  const clampedLeft = clampNumber(left, BUBBLE_EDGE_OFFSET, bounds.maxLeft);
  const clampedTop = clampNumber(top, bounds.minTop, bounds.maxTop);
  const side = preferredSide || (clampedLeft + size.width / 2 < bounds.viewportWidth / 2 ? 'left' : 'right');
  return {
    left: clampedLeft,
    top: clampedTop,
    side,
    topRatio: getBubbleTopRatioFromTop(clampedTop, size),
  };
};

const readBubblePosition = (size: BubbleSize): BubblePosition => {
  const storedSide = String(ConfigService.get('universal_bubble_side') || '').trim();
  const storedRatio = ConfigService.get('universal_bubble_top_ratio') as string;
  if (storedSide || storedRatio) {
    return getBubblePositionFromDock(
      normalizeBubbleSide(storedSide),
      normalizeBubbleTopRatio(storedRatio),
      size
    );
  }

  const legacyLeft = Number.parseFloat(ConfigService.get(LEGACY_BUBBLE_STORAGE_KEYS[0]) as string);
  const legacyTop = Number.parseFloat(ConfigService.get(LEGACY_BUBBLE_STORAGE_KEYS[1]) as string);
  if (Number.isFinite(legacyLeft) && Number.isFinite(legacyTop)) {
    const legacyPosition = getBubblePositionFromPoint(legacyLeft, legacyTop, size);
    return getBubblePositionFromDock(legacyPosition.side, legacyPosition.topRatio, size);
  }

  return getBubblePositionFromDock('right', DEFAULT_BUBBLE_TOP_RATIO, size);
};

const saveBubblePosition = (position: BubblePosition) => {
  try {
    ConfigService.set('universal_bubble_side', position.side);
    ConfigService.set('universal_bubble_top_ratio', position.topRatio.toFixed(4));
    ConfigService.set('universal_bubble_left', String(Math.round(position.left)));
    ConfigService.set('universal_bubble_top', String(Math.round(position.top)));
  } catch (err) {
    console.warn('[Linkual] 气泡位置保存失败', err);
  }
};

const ActionIcon: React.FC<{ name: WidgetIcon }> = ({ name }) => {
  const icons: Record<WidgetIcon, LucideIcon> = {
    add: BadgePlus,
    queue: ListChecks,
    settings: SettingsIcon,
    expand: PanelTopOpen,
    collapse: PanelTopClose,
    translate: Languages,
    clear: X,
    word: Type,
    context: AlignLeft,
  };
  const Icon = icons[name];

  return (
    <Icon className="linkual-universal-button-icon" aria-hidden="true" strokeWidth={2.2} />
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
  const [bubblePosition, setBubblePosition] = useState<BubblePosition>(() => (
    readBubblePosition({ width: DEFAULT_BUBBLE_WIDTH, height: DEFAULT_BUBBLE_HEIGHT })
  ));
  const [expandedAnchor, setExpandedAnchor] = useState<ExpandedAnchor | null>(null);

  const widgetRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleSizeRef = useRef<BubbleSize>({ width: DEFAULT_BUBBLE_WIDTH, height: DEFAULT_BUBBLE_HEIGHT });
  const bubblePositionRef = useRef(bubblePosition);
  const bubbleDragRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(null);
  const bubbleMovedRef = useRef(false);
  const expandedDragRef = useRef<{ pointerId: number; startX: number; startY: number; side: BubbleDockSide; edge: number; top: number } | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const articleTranslation = useArticleTranslation();

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

  useEffect(() => {
    const handleNavigationRefresh = () => {
      setSelection(null);
      setSourceUrl(getPageUrl());

      window.requestAnimationFrame(() => {
        if (isExpanded) measureWidgetHeight();
        syncVisualViewportHeightProperty();
      });
    };

    window.addEventListener(LINKUAL_NAVIGATION_EVENT, handleNavigationRefresh);
    window.addEventListener('pageshow', handleNavigationRefresh);
    return () => {
      window.removeEventListener(LINKUAL_NAVIGATION_EVENT, handleNavigationRefresh);
      window.removeEventListener('pageshow', handleNavigationRefresh);
    };
  }, [isExpanded, measureWidgetHeight]);

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

  const handleBubblePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const rect = bubbleRef.current?.getBoundingClientRect();
    if (!rect) return;
    bubbleSizeRef.current = { width: rect.width, height: rect.height };

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
    const nextPosition = getBubblePositionFromPoint(drag.left + deltaX, drag.top + deltaY, bubbleSizeRef.current);
    bubblePositionRef.current = nextPosition;
    setBubblePosition(nextPosition);
  };

  const handleBubblePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = bubbleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const currentPosition = bubblePositionRef.current || getBubblePositionFromPoint(drag.left, drag.top, bubbleSizeRef.current);
    const nextPosition = getBubblePositionFromDock(currentPosition.side, currentPosition.topRatio, bubbleSizeRef.current);
    bubbleDragRef.current = null;
    if (bubbleMovedRef.current) {
      bubblePositionRef.current = nextPosition;
      setBubblePosition(nextPosition);
      saveBubblePosition(nextPosition);
    }
  };

  useEffect(() => {
    const refreshBubbleSize = () => {
      const rect = bubbleRef.current?.getBoundingClientRect();
      if (rect) bubbleSizeRef.current = { width: rect.width, height: rect.height };
    };
    const clampCurrentPosition = () => setBubblePosition((current) => {
      refreshBubbleSize();
      const nextPosition = getBubblePositionFromDock(current.side, current.topRatio, bubbleSizeRef.current);
      bubblePositionRef.current = nextPosition;
      return nextPosition;
    });

    clampCurrentPosition();
    window.addEventListener('resize', clampCurrentPosition);
    window.visualViewport?.addEventListener('resize', clampCurrentPosition);
    return () => {
      window.removeEventListener('resize', clampCurrentPosition);
      window.visualViewport?.removeEventListener('resize', clampCurrentPosition);
    };
  }, []);

  useEffect(() => {
    const syncStoredBubblePosition = () => {
      if (isExpanded || bubbleDragRef.current || expandedDragRef.current) return;
      const rect = bubbleRef.current?.getBoundingClientRect();
      if (rect) bubbleSizeRef.current = { width: rect.width, height: rect.height };
      const nextPosition = readBubblePosition(bubbleSizeRef.current);
      bubblePositionRef.current = nextPosition;
      setBubblePosition(nextPosition);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') syncStoredBubblePosition();
    };
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || !event.key.startsWith('linkual_universal_bubble_')) return;
      syncStoredBubblePosition();
    };

    window.addEventListener('focus', syncStoredBubblePosition);
    window.addEventListener('pageshow', syncStoredBubblePosition);
    window.addEventListener('storage', handleStorage);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', syncStoredBubblePosition);
      window.removeEventListener('pageshow', syncStoredBubblePosition);
      window.removeEventListener('storage', handleStorage);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isExpanded]);

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

  const getBubbleSize = useCallback(() => {
    const rect = bubbleRef.current?.getBoundingClientRect();
    if (rect) {
      bubbleSizeRef.current = { width: rect.width, height: rect.height };
      return bubbleSizeRef.current;
    }

    return bubbleSizeRef.current;
  }, []);

  const getBubbleAnchor = useCallback((): ExpandedAnchor => {
    const rect = bubbleRef.current?.getBoundingClientRect();
    const current = bubblePositionRef.current;
    const side = current?.side || 'right';
    if (rect) {
      bubbleSizeRef.current = { width: rect.width, height: rect.height };
      return {
        side,
        edge: side === 'right' ? Math.max(getRightScrollbarInset(), getViewportWidth() - rect.right) : Math.max(0, rect.left),
        top: rect.top,
      };
    }

    if (current) {
      const size = getBubbleSize();
      return {
        side: current.side,
        edge: current.side === 'right'
          ? Math.max(getRightScrollbarInset(), getViewportWidth() - current.left - size.width)
          : Math.max(0, current.left),
        top: current.top,
      };
    }

    return {
      side: 'right',
      edge: BUBBLE_EDGE_OFFSET,
      top: getBubblePositionFromDock('right', DEFAULT_BUBBLE_TOP_RATIO, {
        width: DEFAULT_BUBBLE_WIDTH,
        height: DEFAULT_BUBBLE_HEIGHT,
      }).top,
    };
  }, [getBubbleSize]);

  const clampExpandedAnchor = useCallback((anchor: ExpandedAnchor) => {
    const minEdge = anchor.side === 'right' ? getRightScrollbarInset() : BUBBLE_EDGE_OFFSET;
    const maxEdge = Math.max(minEdge, getViewportWidth() - BUBBLE_MARGIN);
    const maxTop = Math.max(BUBBLE_MARGIN, getVisualViewportHeight() - BUBBLE_MARGIN);
    return {
      side: anchor.side,
      edge: clampNumber(anchor.edge, minEdge, maxEdge),
      top: clampNumber(anchor.top, BUBBLE_MARGIN, maxTop),
    };
  }, []);

  const getExpandedWindowStyle = useCallback((anchor: ExpandedAnchor | null) => {
    if (!anchor) return {};

    const baseStyle = {
      top: anchor.top,
      bottom: 'auto',
    };

    return anchor.side === 'left'
      ? {
          ...baseStyle,
          left: anchor.edge,
          right: 'auto',
        } as React.CSSProperties
      : {
          ...baseStyle,
          right: anchor.edge,
          left: 'auto',
        } as React.CSSProperties;
  }, []);

  const persistBubblePosition = useCallback((position: BubblePosition) => {
    const nextPosition = getBubblePositionFromDock(position.side, position.topRatio, getBubbleSize());
    setBubblePosition(nextPosition);
    bubblePositionRef.current = nextPosition;
    saveBubblePosition(nextPosition);
  }, [getBubbleSize]);

  const persistBubblePositionFromAnchor = useCallback((anchor: ExpandedAnchor) => {
    const size = getBubbleSize();
    const left = anchor.side === 'right'
      ? getViewportWidth() - anchor.edge - size.width
      : anchor.edge;
    persistBubblePosition(getBubblePositionFromPoint(left, anchor.top, size, anchor.side));
  }, [getBubbleSize, persistBubblePosition]);

  const handleExpandedPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest('button, input, textarea, select, [contenteditable="true"]')) return;
    const anchor = expandedAnchor || getBubbleAnchor();
    expandedDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      side: anchor.side,
      edge: anchor.edge,
      top: anchor.top,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleExpandedPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = expandedDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    setExpandedAnchor(clampExpandedAnchor({
      side: drag.side,
      edge: drag.side === 'right' ? drag.edge - deltaX : drag.edge + deltaX,
      top: drag.top + event.clientY - drag.startY,
    }));
  };

  const handleExpandedPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = expandedDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    expandedDragRef.current = null;
    const deltaX = event.clientX - drag.startX;
    const anchor = clampExpandedAnchor({
      side: drag.side,
      edge: drag.side === 'right' ? drag.edge - deltaX : drag.edge + deltaX,
      top: drag.top + event.clientY - drag.startY,
    });
    setExpandedAnchor(anchor);
    persistBubblePositionFromAnchor(anchor);
  };

  const handleCollapseWindow = () => {
    setSelection(null);
    setIsExpanded(false);
    if (expandedAnchor) persistBubblePositionFromAnchor(expandedAnchor);
  };

  const handleBubbleExpand = () => {
    setExpandedAnchor(clampExpandedAnchor(getBubbleAnchor()));
    syncVisualViewportHeightProperty();
    setIsExpanded(true);
  };

  useEffect(() => {
    if (!isExpanded) return undefined;

    const clampExpandedAnchorToViewport = () => setExpandedAnchor((current) => {
      if (!current) return current;
      return clampExpandedAnchor(current);
    });
    const frameId = window.requestAnimationFrame(clampExpandedAnchorToViewport);
    window.addEventListener('resize', clampExpandedAnchorToViewport);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', clampExpandedAnchorToViewport);
    };
  }, [clampExpandedAnchor, isExpanded, reservedHeight]);

  if (!isExpanded) {
    return (
      <div
        ref={bubbleRef}
        className={`linkual-universal-expand-bar is-side-${bubblePosition.side}`}
        onPointerDown={handleBubblePointerDown}
        onPointerMove={handleBubblePointerMove}
        onPointerUp={handleBubblePointerUp}
        onPointerCancel={handleBubblePointerUp}
        onClick={handleBubbleClick}
        style={{
          '--linkual-theme': themeColor,
          left: bubblePosition.left,
          top: bubblePosition.top,
          right: 'auto',
          bottom: 'auto',
        } as React.CSSProperties}
        title="Linkual"
      >
        <GripVertical className="linkual-universal-bubble-grip" size={15} strokeWidth={2.1} aria-hidden="true" />
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
            <ActionIcon name="translate" />
          </button>
        )}
        <button
          type="button"
          className="linkual-universal-icon-btn linkual-universal-window-toggle"
          onPointerDown={handleBubbleButtonPointerDown}
          onClick={handleBubbleExpand}
          title="展开 Linkual 工具栏"
          aria-label="展开 Linkual 工具栏"
        >
          <ActionIcon name="expand" />
          <span className="linkual-universal-button-text">展开</span>
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
        ...getExpandedWindowStyle(expandedAnchor),
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
          <ActionIcon name="add" />
          <span>填入</span>
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
                <ActionIcon name="add" />
                填入
              </button>
            </>
          ) : (
            <span className="linkual-universal-muted">未选中文本</span>
          )}
        </div>

        <div className="linkual-universal-actions">
          {statusText && <span className={`linkual-universal-status status-${status}`}>{statusText}</span>}
          <button
            type="button"
            className="linkual-universal-icon-btn linkual-universal-window-toggle"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleCollapseWindow}
            title="收起 Linkual 工具栏"
            aria-label="收起 Linkual 工具栏"
          >
            <ActionIcon name="collapse" />
            <span className="linkual-universal-button-text">收起</span>
          </button>
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
            title="词块"
            aria-label="词块"
            aria-pressed={selectionMode === 'word'}
          >
            <ActionIcon name="word" />
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
            title="上下文"
            aria-label="上下文"
            aria-pressed={selectionMode === 'context'}
          >
            <ActionIcon name="context" />
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
          <ActionIcon name="clear" />
        </button>

        <button type="button" className="linkual-universal-send" onClick={handleAddToQueue} disabled={!canSend} title="加入队列" aria-label="加入队列">
          <ActionIcon name="add" />
        </button>

        <div className="linkual-universal-inline-actions">
          <button type="button" className="linkual-universal-icon-btn linkual-universal-queue-btn" onClick={handleQueueToggle} title="制卡队列" aria-label={`制卡队列${queueCount > 0 ? ` ${queueCount}` : ''}`}>
            <ActionIcon name="queue" />
            {queueCount > 0 && <span className="linkual-universal-queue-count">{queueCount}</span>}
          </button>
          <button type="button" className="linkual-universal-icon-btn" onClick={onOpenSettings} title="设置" aria-label="设置">
            <ActionIcon name="settings" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default UniversalVocabWidget;
