import React, { useState, useRef, useEffect, useCallback } from 'react';
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

const normalizeSelectedText = (value: string) => value.replace(/\s+/g, ' ').trim();

type SelectionInputType = 'mouse' | 'touch' | 'pen';
type SelectionBoxPlacement = 'floating' | 'dock';
type SelectionBox = { text: string, top: number, left: number, placement: SelectionBoxPlacement };

const isNodeInside = (node: Node | null, container: HTMLElement | null) => {
  if (!node || !container) return false;
  const target = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return !!target && container.contains(target);
};

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
    if (isActive && itemRef.current) {
      itemRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isActive]);

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
    const selection = window.getSelection();
    const text = normalizeSelectedText(selection?.toString() ?? '');

    if (!selection || selection.rangeCount === 0 || !text || text.length > MAX_SELECTION_LENGTH) {
      setSelectionBox(null);
      return;
    }

    if (!isNodeInside(selection.anchorNode, textRef.current) || !isNodeInside(selection.focusNode, textRef.current)) {
      setSelectionBox(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = getVisibleRangeRect(range);
    if (rect) {
      const position = getSelectionBoxPosition(rect, text);
      const placement = shouldDockSelectionBox() ? 'dock' : 'floating';
      setSelectionBox({
        text,
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
    rememberSelectionInput(e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse');
  };

  const handleSelectionPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    rememberSelectionInput(e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse');
    scheduleSelectionRefresh(e.pointerType === 'touch' ? 180 : 0);
  };

  const handleSelectionMouseDown = () => {
    rememberSelectionInput('mouse');
  };

  const handleSelectionMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    rememberSelectionInput('mouse');
    scheduleSelectionRefresh(0);
  };

  const handleSelectionTouchStart = () => {
    rememberSelectionInput('touch');
  };

  const handleSelectionTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    e.stopPropagation();
    rememberSelectionInput('touch');
    scheduleSelectionRefresh(180);
  };

  useEffect(() => {
    const handleSelectionChange = () => scheduleSelectionRefresh(120);
    document.addEventListener('selectionchange', handleSelectionChange);

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      if (selectionTimerRef.current !== null) {
        window.clearTimeout(selectionTimerRef.current);
      }
    };
  }, [scheduleSelectionRefresh]);

  useEffect(() => {
    const closeBox = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.linkual-selection-add')) return;
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
    window.getSelection()?.removeAllRanges();
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
    const timeout = parseInt(ConfigService.get('api_timeout') as string, 10) || 15;

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
          <span>+</span>
          <span className="linkual-selection-add-text">"{selectionBox.text}"</span>
        </button>
      )}

      <div className={ctrlClass}>
        <span className="tag-btn tag-play" onClick={handlePlay} title="点击跳转并播放">
          ▶ {Math.floor(data.start / 60)}:{(Math.floor(data.start % 60)).toString().padStart(2, '0')}
        </span>
        <span className="tag-btn tag-pin" onClick={handlePin} title="定位到此处并暂停">📌</span>
        
        <span className="btn-parse" onClick={handleParse}>
          {isGenerating ? '解析中' : (aiContent ? '重新解析' : '解析')}
        </span>
        <span className="btn-chevron" onClick={handleToggle}>{isExpanded ? '▼' : '◀'}</span>
      </div>
      
      <div
        className="text-content"
        ref={textRef}
        onPointerDown={handleSelectionPointerDown}
        onPointerUp={handleSelectionPointerUp}
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
