import React, { useState, useEffect, useRef } from 'react';
import { Subtitle } from '../types';
import { ConfigService } from '../services/configService';

interface LanSyncProps {
  subs: Subtitle[];
  activeIndex: number;
}

const LanSync: React.FC<LanSyncProps> = ({ subs, activeIndex }) => {
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [payloadStr, setPayloadStr] = useState('');
  const [metaInfo, setMetaInfo] = useState({ targetIndex: 0, totalContext: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [textareaHeight, setTextareaHeight] = useState(() => Number(ConfigService.get('lan_textarea_height')) || 200);

  useEffect(() => {
    const syncHeight = () => {
      setTextareaHeight(Number(ConfigService.get('lan_textarea_height')) || 200);
    };
    window.addEventListener('linkual_settings_updated', syncHeight);
    return () => window.removeEventListener('linkual_settings_updated', syncHeight);
  }, []);

  useEffect(() => {
    setPayloadStr(JSON.stringify([], null, 2));
  }, []);

  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = textareaHeight;
    let currentHeight = startHeight;

    const onMouseMove = (ev: MouseEvent) => {
      let newHeight = startHeight + (startY - ev.clientY);
      if (newHeight < 60) newHeight = 60;
      if (newHeight > window.innerHeight * 0.7) newHeight = window.innerHeight * 0.7;

      currentHeight = newHeight;
      setTextareaHeight(newHeight);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      ConfigService.set('lan_textarea_height', currentHeight.toString());
      window.dispatchEvent(new Event('linkual_settings_updated'));
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      
      const newPayload = payloadStr.substring(0, start) + '  ' + payloadStr.substring(end);
      setPayloadStr(newPayload);
      
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 2;
        }
      }, 0);
    }
  };

  const handleInjectSubs = () => {
    if (activeIndex === -1 || subs.length === 0) {
      alert("⚠️ 当前没有激活或 Pin 中的字幕！请先播放视频或点击某条字幕的 Pin 按钮。");
      return;
    }

    const ctxSize = parseInt(ConfigService.get('api_ctxSize') as string, 10) || 0;
    const startIdx = Math.max(0, activeIndex - ctxSize);
    const endIdx = Math.min(subs.length - 1, activeIndex + ctxSize);
    
    const targetSubs = subs.slice(startIdx, endIdx + 1);

    const formattedData = targetSubs.map(sub => ({
      text: sub.text,
      focusWords: "", 
      time: sub.start
    }));

    setMetaInfo({ targetIndex: activeIndex - startIdx, totalContext: targetSubs.length });
    setPayloadStr(JSON.stringify(formattedData, null, 2));
  };

  const handleSend = async () => {
    const serverUrl = ConfigService.get('lan_sync_url') as string;
    if (!serverUrl) {
      alert('⚠️ 请先在顶部【⚙️全局设置 -> 📡局域网】中配置后端地址');
      return;
    }

    setStatus('sending');

    try {
      let parsedData = JSON.parse(payloadStr);

      if (parsedData && !Array.isArray(parsedData) && Array.isArray(parsedData.data)) {
        parsedData = parsedData.data;
      }

      let offsetHours = parseFloat(ConfigService.get('lan_timezone') as string);
      if (isNaN(offsetHours)) {
        offsetHours = 0 - new Date().getTimezoneOffset() / 60;
      }

      const now = new Date();
      const targetTimeMs = now.getTime() + (offsetHours * 3600000);
      const targetDate = new Date(targetTimeMs);
      
      const pad = (n: number) => n.toString().padStart(2, '0');
      const year = targetDate.getUTCFullYear();
      const month = pad(targetDate.getUTCMonth() + 1);
      const day = pad(targetDate.getUTCDate());
      const hours = pad(targetDate.getUTCHours());
      const minutes = pad(targetDate.getUTCMinutes());
      const seconds = pad(targetDate.getUTCSeconds());
      
      const sign = offsetHours >= 0 ? '+' : '-';
      const absOffset = Math.abs(offsetHours);
      const offsetH = pad(Math.floor(absOffset));
      const offsetM = pad(Math.round((absOffset % 1) * 60));
      
      const formattedTimestamp = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetH}:${offsetM}`;

      const fullPayload = {
        action: ConfigService.get('lan_action') as string,
        timestamp: formattedTimestamp,
        videoUrl: window.location.href,
        message: ConfigService.get('lan_message') as string,
        targetIndex: metaInfo.targetIndex,
        totalContext: metaInfo.totalContext,
        data: parsedData
      };

      console.log('🚀 [Linkual] 最终发送至后端的 Payload:', fullPayload);

      const res = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullPayload),
      });

      if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

      setStatus('success');
      setTimeout(() => setStatus('idle'), 2000); 
    } catch (error: any) {
      console.error('[Linkual] 同步到后端失败:', error);
      if (error instanceof SyntaxError) {
        alert("JSON 格式错误，请检查输入框内容是否为合法的 JSON。");
      }
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  };

  return (
    <div className="lan-sync-module" style={{ position: 'relative' }}> 
      
      <div 
        className="lan-resizer" 
        onMouseDown={startResize} 
        title="上下拖拽调整编辑区高度"
      />

      <style>{`
        /* 自定义拖拽条样式 */
        .lan-resizer {
          position: absolute;
          top: -3px;
          left: 0;
          width: 100%;
          height: 6px;
          cursor: ns-resize; /* 鼠标变为上下拖拽箭头 */
          background: transparent;
          z-index: 10;
          transition: background 0.2s;
        }
        .lan-resizer:hover, .lan-resizer:active {
          background: var(--linkual-theme, #6a1b9a);
        }

        .sync-textarea-custom {
          resize: none; /* [核心修复]：彻底禁用浏览器原生的右下角拖拽功能，防止冲突 */
          width: 100%;
          padding: 8px;
          box-sizing: border-box;
          font-size: 13px;
          font-family: monospace;
          border: 1px solid #ccc;
          border-radius: 4px;
          outline: none;
        }
        .sync-textarea-custom:focus {
          border-color: var(--linkual-theme, #6a1b9a);
        }
      `}</style>

      <div className="sync-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#555' }}>Data Payload 编辑</span>
        <button 
          onClick={handleInjectSubs} 
          style={{ fontSize: '11px', padding: '2px 6px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #ccc', background: '#fff' }}
          title="提取【目标字幕】及其相关字段"
        >
          ⬇️ 注入待办单词数据
        </button>
      </div>
      
      <textarea 
        ref={textareaRef}
        className="sync-textarea sync-textarea-custom" 
        style={{ height: `${textareaHeight}px` }}
        value={payloadStr} 
        onChange={(e) => setPayloadStr(e.target.value)}
        onKeyDown={handleKeyDown} 
        placeholder="在此编辑 data 数组..."
      />
      
      <button 
        className={`sync-btn ${status}`} 
        style={{ marginTop: '10px' }}
        onClick={handleSend}
        disabled={status === 'sending'}
      >
        {status === 'idle' && '📤 发送至局域网后端'}
        {status === 'sending' && '⏳ 发送中...'}
        {status === 'success' && '✅ 发送成功'}
        {status === 'error' && '❌ 发送失败'}
      </button>
    </div>
  );
};

export default LanSync;