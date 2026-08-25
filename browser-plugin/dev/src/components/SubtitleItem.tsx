import React, { useState, useRef, useEffect, useCallback } from 'react';
import { BadgePlus, ChevronDown, ChevronLeft, MapPin, Play, Sparkles } from 'lucide-react';
import { fetchLlmStream } from '../services/llmApi';
import { IVideoAdapter } from '../adapters/BaseAdapter';
import { Subtitle } from '../types';
import { ConfigService } from '../services/configService';
import { enqueueVocabTask } from '../services/vocabQueueStore';

interface SubtitleItemProps {
  data: Subtitle; 
  index: number; 
  allSubs: Subtitle[];
  isActive: boolean; 
  adapter: IVideoAdapter;
}

const MAX_SELECTION_LENGTH = 50;
const SELECTION_BOX_MARGIN = 12;
const TOUCH_SELECTION_RECENCY_MS = 3000;
const SUBTITLE_AUTO_SCROLL_PAUSE_MS = 5000;

const normalizeSelectedText = (value: string) => value.replace(/\s+/g, ' ').trim();

type SelectionInputType = 'mouse' | 'touch' | 'pen';
type SelectionBoxPlacement = 'floating' | 'dock';
type SelectionBox = { text: string, top: number, left: number, placement: SelectionBoxPlacement };
type ShadowRootWithSelection = ShadowRoot & {
  getSelection?: () => Selection | null;
};

const isNodeInside = (node: Node | null, container: HTMLElement | null) => {
  if (!node || !container) return false;
  const target = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return !!target && container.contains(target);
};

const isShadowRoot = (root: Node): root is ShadowRoot => (
  typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot
);

const isSelectionEventTarget = (target: Node | null | undefined): target is Document | ShadowRoot => (
  !!target && (target instanceof Document || isShadowRoot(target))
);

const isRangeInside = (range: Range | StaticRange, container: HTMLElement) => (
  isNodeInside(range.startContainer, container) && isNodeInside(range.endContainer, container)
);

const getVisibleRangeRect = (range: Range) => {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length > 0) return rects[0];

  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
};

const getSelectionBoxPosition = (rect: DOMRect, text: string) => {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  const estimatedButtonWidth = Math.min(320, viewportWidth - SELECTION_BOX_MARGIN * 2, 34 + text.length * 8);
  const horizontalInset = estimatedButtonWidth / 2 + SELECTION_BOX_MARGIN;

  const left = Math.min(
    viewportLeft + viewportWidth - horizontalInset,
    Math.max(viewportLeft + horizontalInset, rect.left + rect.width / 2)
  );

  let top = rect.top - 48;
  if (top < viewportTop + SELECTION_BOX_MARGIN) {
    top = rect.bottom + 10;
  }
  top = Math.min(viewportTop + viewportHeight - 52, Math.max(viewportTop + SELECTION_BOX_MARGIN, top));

  return { top, left };
};

const hasCoarsePointer = () => (
  typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
);

const staticRangeToRange = (staticRange: StaticRange) => {
  const range = document.createRange();
  range.setStart(staticRange.startContainer, staticRange.startOffset);
  range.setEnd(staticRange.endContainer, staticRange.endOffset);
  return range;
};

const getComposedSelectionRanges = (selection: Selection, root: ShadowRoot) => {
  if (typeof selection.getComposedRanges !== 'function') return [];

  try {
    return selection.getComposedRanges({ shadowRoots: [root] });
  } catch {}

  try {
    return (selection.getComposedRanges as unknown as (...shadowRoots: ShadowRoot[]) => StaticRange[])(root);
  } catch {}

  return [];
};

const getRootSelection = (root: Node) => {
  if (isShadowRoot(root)) {
    const shadowSelection = (root as ShadowRootWithSelection).getSelection?.();
    if (shadowSelection && (shadowSelection.rangeCount > 0 || !shadowSelection.isCollapsed)) return shadowSelection;
  }

  return (typeof document.getSelection === 'function' ? document.getSelection() : window.getSelection()) ?? null;
};

const getSubtitleSelection = (textContainer: HTMLElement | null) => {
  if (!textContainer) return null;

  const root = textContainer.getRootNode();
  const selection = getRootSelection(root);

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  if (isShadowRoot(root)) {
    const composedRanges = getComposedSelectionRanges(selection, root);
    const composedRange = composedRanges.find((range) => isRangeInside(range, textContainer));
    if (composedRange) {
      const range = staticRangeToRange(composedRange);
      const text = normalizeSelectedText(range.toString() || selection.toString() || '');
      if (text && text.length <= MAX_SELECTION_LENGTH) {
        return { selection, range, text };
      }
    }
  }

  const range = selection.getRangeAt(0);
  const text = normalizeSelectedText(selection.toString() || range.toString() || '');
  if (!text || text.length > MAX_SELECTION_LENGTH) return null;
  if (
    !isRangeInside(range, textContainer)
    && (!isNodeInside(selection.anchorNode, textContainer) || !isNodeInside(selection.focusNode, textContainer))
  ) {
    return null;
  }

  return { selection, range, text };
};

let subtitleAutoScrollPausedUntil = 0;
let subtitleSelectionGestureActive = false;

const pauseSubtitleAutoScroll = (ms = SUBTITLE_AUTO_SCROLL_PAUSE_MS) => {
  subtitleAutoScrollPausedUntil = Math.max(subtitleAutoScrollPausedUntil, Date.now() + ms);
};

const lockSubtitleSelectionGesture = (ms = SUBTITLE_AUTO_SCROLL_PAUSE_MS) => {
  subtitleSelectionGestureActive = true;
  pauseSubtitleAutoScroll(ms);
};

const clearSubtitleSelectionGesture = () => {
  subtitleSelectionGestureActive = false;
};

const isSubtitleAutoScrollPaused = () => (
  subtitleSelectionGestureActive || Date.now() < subtitleAutoScrollPausedUntil
);

const SubtitleItem: React.FC<SubtitleItemProps> = ({ data, index, allSubs, isActive, adapter }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiContent, setAiContent] = useState('');
  const [isError, setIsError] = useState(false);
  
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);

  const itemRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const ignoreNextClickRef = useRef(false);
  const lastSelectionInputRef = useRef<SelectionInputType>('mouse');
  const lastTouchSelectionAtRef = useRef(0);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current();
        abortRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isActive && itemRef.current && !isSubtitleAutoScrollPaused()) {
      itemRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isActive]);

  useEffect(() => {
    return () => {
      clearSubtitleSelectionGesture();
    };
  }, []);

  const handlePlay = (e: React.MouseEvent) => { 
    e.stopPropagation(); 
    adapter.seekTo(data.start); 
    adapter.play(); 
  };
  
  const handlePin = (e: React.MouseEvent) => { 
    e.stopPropagation(); 
    adapter.seekTo(data.start); 
    adapter.pause(); 
  };

  const rememberSelectionInput = useCallback((inputType: SelectionInputType) => {
    lastSelectionInputRef.current = inputType;
    if (inputType === 'touch') {
      lastTouchSelectionAtRef.current = Date.now();
    }
  }, []);

  const shouldDockSelectionBox = useCallback(() => (
    lastSelectionInputRef.current === 'touch'
    || Date.now() - lastTouchSelectionAtRef.current < TOUCH_SELECTION_RECENCY_MS
    || hasCoarsePointer()
  ), []);

  const refreshSelectionBox = useCallback(() => {
    const subtitleSelection = getSubtitleSelection(textRef.current);
    if (!subtitleSelection) {
      setSelectionBox(null);
      return;
    }

    const rect = getVisibleRangeRect(subtitleSelection.range);
    if (rect) {
      const position = getSelectionBoxPosition(rect, subtitleSelection.text);
      const placement = shouldDockSelectionBox() ? 'dock' : 'floating';
      lockSubtitleSelectionGesture();
      setSelectionBox({
        text: subtitleSelection.text,
        top: position.top,
        left: position.left,
        placement
      });
    } else {
      setSelectionBox(null);
    }
  }, [shouldDockSelectionBox]);

  const scheduleSelectionRefresh = useCallback((delay = 0) => {
    if (selectionTimerRef.current !== null) {
      window.clearTimeout(selectionTimerRef.current);
    }

    selectionTimerRef.current = window.setTimeout(() => {
      selectionTimerRef.current = null;
      refreshSelectionBox();
    }, delay);
  }, [refreshSelectionBox]);

  const handleSelectionPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    lockSubtitleSelectionGesture();
    rememberSelectionInput(e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse');
  };

  const handleSelectionPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    rememberSelectionInput(e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse');
    scheduleSelectionRefresh(e.pointerType === 'touch' ? 180 : 0);
  };

  const handleSelectionPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    rememberSelectionInput(e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse');
    scheduleSelectionRefresh(e.pointerType === 'touch' ? 180 : 0);
  };

  const handleSelectionMouseDown = () => {
    lockSubtitleSelectionGesture();
    rememberSelectionInput('mouse');
  };

  const handleSelectionMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    rememberSelectionInput('mouse');
    scheduleSelectionRefresh(0);
  };

  const handleSelectionTouchStart = () => {
    lockSubtitleSelectionGesture();
    rememberSelectionInput('touch');
  };

  const handleSelectionTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    e.stopPropagation();
    rememberSelectionInput('touch');
    scheduleSelectionRefresh(180);
  };

  useEffect(() => {
    const handleSelectionChange = () => scheduleSelectionRefresh(120);
    const handleGlobalPointerUp = () => {
      if (subtitleSelectionGestureActive) scheduleSelectionRefresh(20);
    };
    const selectionTargets = new Set<EventTarget>([document]);
    const root = textRef.current?.getRootNode();
    if (isSelectionEventTarget(root)) {
      selectionTargets.add(root);
    }

    selectionTargets.forEach((target) => target.addEventListener('selectionchange', handleSelectionChange));
    window.addEventListener('pointerup', handleGlobalPointerUp, true);
    window.addEventListener('touchend', handleGlobalPointerUp, true);

    return () => {
      selectionTargets.forEach((target) => target.removeEventListener('selectionchange', handleSelectionChange));
      window.removeEventListener('pointerup', handleGlobalPointerUp, true);
      window.removeEventListener('touchend', handleGlobalPointerUp, true);
      if (selectionTimerRef.current !== null) {
        window.clearTimeout(selectionTimerRef.current);
      }
    };
  }, [scheduleSelectionRefresh]);

  useEffect(() => {
    const closeBox = (event: Event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.some((node) => node instanceof Element && node.classList.contains('linkual-selection-add'))) return;
      if (path.some((node) => node instanceof Element && node.classList.contains('text-content'))) return;
      clearSubtitleSelectionGesture();
      setSelectionBox(null);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectionBox(null);
    };

    window.addEventListener('pointerdown', closeBox, true);
    window.addEventListener('touchstart', closeBox, true);
    window.addEventListener('mousedown', closeBox, true);
    window.addEventListener('scroll', closeBox, true);
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      window.removeEventListener('pointerdown', closeBox, true);
      window.removeEventListener('touchstart', closeBox, true);
      window.removeEventListener('mousedown', closeBox, true);
      window.removeEventListener('scroll', closeBox, true);
      window.removeEventListener('keydown', closeOnEscape);
      clearSubtitleSelectionGesture();
    };
  }, []);

  const handleAddVocab = (e: React.MouseEvent | React.PointerEvent | React.TouchEvent, word: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    let cleanUrl = window.location.href;
    try {
      const urlObj = new URL(cleanUrl);
      urlObj.searchParams.delete('t'); 
      cleanUrl = urlObj.toString();
    } catch (err) {}

    let videoTitle = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent;
    if (!videoTitle) {
      videoTitle = document.title.replace(/^\(\d+\)\s+/, '').replace(/ - YouTube$/, '');
    }

    const ctxSize = parseInt(ConfigService.get('api_ctxSize') as string, 10) || 2;
    const startIdx = Math.max(0, index - ctxSize);
    const endIdx = Math.min(allSubs.length - 1, index + ctxSize);
    let contextBlock = "";
    for (let i = startIdx; i <= endIdx; i++) {
      contextBlock += allSubs[i].text + " ";
    }

    try {
      enqueueVocabTask({
        word: word,
        context: contextBlock.trim(),
        source: videoTitle?.trim(),
        youtube: { url: cleanUrl, timestamp: Math.floor(data.start) }
      });
    } catch (err) {
      console.error('[Linkual] 加入制卡队列失败:', err);
    }
    
    setSelectionBox(null);
    const root = textRef.current?.getRootNode();
    if (root) {
      getRootSelection(root)?.removeAllRanges();
    } else {
      window.getSelection()?.removeAllRanges();
    }
  };

  const handleSelectionButtonPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (e.pointerType !== 'touch' || !selectionBox) return;

    ignoreNextClickRef.current = true;
    window.setTimeout(() => {
      ignoreNextClickRef.current = false;
    }, 400);
    handleAddVocab(e, selectionBox.text);
  };

  const handleSelectionButtonTouchEnd = (e: React.TouchEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (ignoreNextClickRef.current || !selectionBox) return;

    ignoreNextClickRef.current = true;
    window.setTimeout(() => {
      ignoreNextClickRef.current = false;
    }, 400);
    handleAddVocab(e, selectionBox.text);
  };

  const handleSelectionButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!selectionBox) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (ignoreNextClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      ignoreNextClickRef.current = false;
      return;
    }

    handleAddVocab(e, selectionBox.text);
  };

  const handleParse = (e: React.MouseEvent, forceExpand = false) => {
    e.stopPropagation();
    if (isGenerating && abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    if (forceExpand) setIsExpanded(true);
    
    const apiKey = ConfigService.get('api_key').trim();
    const apiUrl = ConfigService.get('api_url').trim();
    const apiModel = ConfigService.get('api_model').trim();
    const systemPrompt = ConfigService.get('api_prompt');
    const ctxSize = parseInt(ConfigService.get('api_ctxSize') as string, 10);
    const timeout = parseInt(ConfigService.get('api_timeout') as string, 10) || 60;

    if (!apiKey) {
      setIsError(true); 
      setAiContent('请在设置中填入 API Key！'); 
      setIsExpanded(true);
      return;
    }

    setIsGenerating(true); 
    setIsError(false); 
    setAiContent('解析语境中...\n'); 
    setIsExpanded(true);

    const startIdx = Math.max(0, index - ctxSize);
    const endIdx = Math.min(allSubs.length - 1, index + ctxSize);
    let contextBlock = "";
    for (let i = startIdx; i <= endIdx; i++) {
      if (i === index) contextBlock += `【目标字幕】：${allSubs[i].text}\n`;
      else contextBlock += `（上下文）：${allSubs[i].text}\n`;
    }

    setAiContent(''); 

    const { abort } = fetchLlmStream({
      apiUrl, apiKey, apiModel, systemPrompt,
      timeoutSec: timeout,
      userPrompt: `请根据以下字幕片段进行解释：\n\n${contextBlock}`,
      onData: (chunk) => setAiContent(prev => prev + chunk),
      onError: (err) => { 
        if (err === 'ABORTED') return;
        setIsError(true); 
        setAiContent(prev => prev + err); 
        setIsGenerating(false); 
      },
      onDone: () => {
        setIsGenerating(false);
        abortRef.current = null;
      }
    });

    abortRef.current = abort;
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!aiContent && !isGenerating && !isError) {
      handleParse(e, true); 
    } else {
      setIsExpanded(!isExpanded);
    }
  };

  const itemClass = `item ${isActive ? 'active' : ''}`;
  const ctrlClass = `ctrl-bar ${isError ? 'error' : (aiContent ? 'done' : '')}`;

  return (
    <div className={itemClass} ref={itemRef}>
      
      {selectionBox && (
        <button
          type="button"
          className={`linkual-selection-add linkual-selection-add-${selectionBox.placement}`}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={handleSelectionButtonPointerUp}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={handleSelectionButtonTouchEnd}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleSelectionButtonClick}
          style={selectionBox.placement === 'floating' ? {
            top: selectionBox.top,
            left: selectionBox.left
          } : undefined}
        >
          <BadgePlus className="linkual-selection-add-icon" size={16} strokeWidth={2.2} />
          <span className="linkual-selection-add-text">"{selectionBox.text}"</span>
        </button>
      )}

      <div className={ctrlClass}>
        <button type="button" className="tag-btn tag-play" onClick={handlePlay} title="点击跳转并播放">
          <Play className="linkual-subtitle-icon" size={12} strokeWidth={2.4} />
          <span>{Math.floor(data.start / 60)}:{(Math.floor(data.start % 60)).toString().padStart(2, '0')}</span>
        </button>
        <button type="button" className="tag-btn tag-pin" onClick={handlePin} title="定位到此处并暂停" aria-label="定位到此处并暂停">
          <MapPin className="linkual-subtitle-icon" size={13} strokeWidth={2.3} />
        </button>
        
        <button type="button" className="btn-parse" onClick={handleParse}>
          <Sparkles className="linkual-subtitle-icon" size={13} strokeWidth={2.2} />
          {isGenerating ? '解析中' : (aiContent ? '重新解析' : '解析')}
        </button>
        <button type="button" className="btn-chevron" onClick={handleToggle} title={isExpanded ? '收起解析' : '展开解析'} aria-label={isExpanded ? '收起解析' : '展开解析'}>
          {isExpanded ? (
            <ChevronDown className="linkual-subtitle-icon" size={15} strokeWidth={2.3} />
          ) : (
            <ChevronLeft className="linkual-subtitle-icon" size={15} strokeWidth={2.3} />
          )}
        </button>
      </div>
      
      <div
        className="text-content"
        ref={textRef}
        onPointerDown={handleSelectionPointerDown}
        onPointerUp={handleSelectionPointerUp}
        onPointerCancel={handleSelectionPointerCancel}
        onMouseDown={handleSelectionMouseDown}
        onMouseUp={handleSelectionMouseUp}
        onTouchStart={handleSelectionTouchStart}
        onTouchEnd={handleSelectionTouchEnd}
      >
        {data.text}
      </div>
      
      {isExpanded && (
        <div className="ai-box" style={{ color: isError ? '#c62828' : '#444' }}>
          {aiContent}
        </div>
      )}
    </div>
  );
};

export default SubtitleItem;
