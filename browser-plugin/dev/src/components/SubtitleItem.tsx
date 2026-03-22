import React, { useState, useRef, useEffect } from 'react';
import { fetchLlmStream } from '../services/llmApi';
import { IVideoAdapter } from '../adapters/BaseAdapter';
import { Subtitle } from '../types';
import { ConfigService } from '../services/configService';

interface SubtitleItemProps {
  data: Subtitle; index: number; allSubs: Subtitle[];
  isActive: boolean; adapter: IVideoAdapter;
}

const SubtitleItem: React.FC<SubtitleItemProps> = ({ data, index, allSubs, isActive, adapter }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiContent, setAiContent] = useState('');
  const [isError, setIsError] = useState(false);
  
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
    if (isActive && itemRef.current) itemRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [isActive]);

  const handlePlay = (e: React.MouseEvent) => { e.stopPropagation(); adapter.seekTo(data.start); adapter.play(); };
  const handlePin = (e: React.MouseEvent) => { e.stopPropagation(); adapter.seekTo(data.start); adapter.pause(); };

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
    const ctxSize = parseInt(ConfigService.get('api_ctxSize'), 10);
    const timeout = parseInt(ConfigService.get('api_timeout'), 10) || 15;

    if (!apiKey) {
      setIsError(true); setAiContent('⚠️ 请在设置中填入 API Key！'); setIsExpanded(true);
      return;
    }

    setIsGenerating(true); setIsError(false); setAiContent('🧠 分析中...\n'); setIsExpanded(true);

    const startIdx = Math.max(0, index - ctxSize);
    const endIdx = Math.min(allSubs.length - 1, index + ctxSize);
    let contextBlock = "";
    for (let i = startIdx; i <= endIdx; i++) {
      if (i === index) contextBlock += `👉 【目标字幕】：${allSubs[i].text}\n`;
      else contextBlock += `（上下文）：${allSubs[i].text}\n`;
    }

    setAiContent(''); 

    const { abort } = fetchLlmStream({
      apiUrl, apiKey, apiModel, systemPrompt,
      timeoutSec: timeout,
      userPrompt: `请根据以下字幕片段进行分析：\n\n${contextBlock}`,
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
    if (!aiContent && !isGenerating && !isError) handleParse(e, true); else setIsExpanded(!isExpanded);
  };

  const itemClass = `item ${isActive ? 'active' : ''}`;
  const ctrlClass = `ctrl-bar ${isError ? 'error' : (aiContent ? 'done' : '')}`;

  return (
    <div className={itemClass} ref={itemRef}>
      <div className={ctrlClass}>
        <span className="tag-btn tag-play" onClick={handlePlay} title="点击跳转并播放">
          ▶ {Math.floor(data.start / 60)}:{(Math.floor(data.start % 60)).toString().padStart(2, '0')}
        </span>
        <span className="tag-btn tag-pin" onClick={handlePin} title="定位到此处并暂停">📌 Pin</span>
        <span className="btn-parse" onClick={handleParse}>
          {isGenerating ? '🔄 解析中' : (aiContent ? '🤖 重新解析' : '🤖 点击解析')}
        </span>
        <span className="btn-chevron" onClick={handleToggle}>{isExpanded ? '▼' : '◀'}</span>
      </div>
      <div className="text-content">{data.text}</div>
      {isExpanded && <div className="ai-box" style={{ color: isError ? '#c62828' : '#444' }}>{aiContent}</div>}
    </div>
  );
};
export default SubtitleItem;