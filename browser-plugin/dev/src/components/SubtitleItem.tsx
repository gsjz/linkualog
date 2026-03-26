import React, { useState, useRef, useEffect } from 'react';
import { fetchLlmStream } from '../services/llmApi';
import { IVideoAdapter } from '../adapters/BaseAdapter';
import { Subtitle } from '../types';
import { ConfigService } from '../services/configService';

interface SubtitleItemProps {
  data: Subtitle; 
  index: number; 
  allSubs: Subtitle[];
  isActive: boolean; 
  adapter: IVideoAdapter;
}

const SubtitleItem: React.FC<SubtitleItemProps> = ({ data, index, allSubs, isActive, adapter }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiContent, setAiContent] = useState('');
  const [isError, setIsError] = useState(false);
  
  const [selectionBox, setSelectionBox] = useState<{ text: string, top: number, left: number } | null>(null);

  const itemRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

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

  const handleMouseUp = (e: React.MouseEvent) => {
    e.stopPropagation();
    const selection = window.getSelection();
    const text = selection?.toString().trim();

    if (text && text.length > 0 && text.length < 50) {
      const range = selection!.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setSelectionBox({
        text,
        top: rect.top - 35, 
        left: rect.left + rect.width / 2
      });
    } else {
      setSelectionBox(null);
    }
  };

  useEffect(() => {
    const closeBox = () => setSelectionBox(null);
    window.addEventListener('mousedown', closeBox);
    return () => window.removeEventListener('mousedown', closeBox);
  }, []);

  const handleAddVocab = (e: React.MouseEvent, word: string) => {
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

    window.dispatchEvent(new CustomEvent('linkual-add-vocab', {
      detail: {
        word: word,
        context: contextBlock.trim(),
        source: videoTitle?.trim(),
        youtube: { url: cleanUrl, timestamp: Math.floor(data.start) },
        autoOpen: true
      }
    }));
    
    setSelectionBox(null);
    window.getSelection()?.removeAllRanges();
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
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }} 
          onClick={(e) => handleAddVocab(e, selectionBox.text)}
          style={{
            position: 'fixed',
            top: selectionBox.top,
            left: selectionBox.left,
            transform: 'translateX(-50%)',
            zIndex: 999999,
            padding: '6px 12px',
            background: 'var(--linkual-theme, #6a1b9a)',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}
        >
          + "{selectionBox.text}"
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
      
      <div className="text-content" onMouseUp={handleMouseUp}>{data.text}</div>
      
      {isExpanded && (
        <div className="ai-box" style={{ color: isError ? '#c62828' : '#444' }}>
          {aiContent}
        </div>
      )}
    </div>
  );
};

export default SubtitleItem;