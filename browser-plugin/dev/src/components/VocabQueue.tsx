import React, { useState, useEffect, useRef } from 'react';
import { ConfigService } from '../services/configService';
import { fetchLlmStream } from '../services/llmApi';

export interface VocabTask {
  id: string;
  word: string;
  context: string;
  source: string;
  youtube?: { url: string; timestamp: number };
  date: string; 
  category: string;
  status: 'idle' | 'fetching_llm' | 'sending' | 'success' | 'failed';
  error: string | null;
  rawJson?: string;
  llmResult?: { pronunciation?: string, definitions?: string[], explanation?: string };
}

const VocabQueue: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(ConfigService.get('lan_action') as string || 'Video_Sync');
  const [themeColor, setThemeColor] = useState(ConfigService.get('theme_color') as string || '#6a1b9a');

  const [tasks, setTasks] = useState<VocabTask[]>(() => {
    try {
      const saved = localStorage.getItem('linkual_vocab_queue');
      if (saved) return JSON.parse(saved);
    } catch(e) {}
    return [];
  });

  useEffect(() => {
    localStorage.setItem('linkual_vocab_queue', JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    const syncAcrossTabs = (e: StorageEvent) => {
      if (e.key === 'linkual_vocab_queue' && e.newValue) {
        try {
          setTasks(JSON.parse(e.newValue));
        } catch(err) {}
      }
    };
    window.addEventListener('storage', syncAcrossTabs);
    return () => window.removeEventListener('storage', syncAcrossTabs);
  }, []);

  const [position, setPosition] = useState({ left: 24, bottom: 24 });
  const [isDragging, setIsDragging] = useState(false);
  const offset = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  useEffect(() => {
    const handleConfigUpdate = () => {
      setSelectedCategory(ConfigService.get('lan_action') as string || 'Video_Sync');
      setThemeColor(ConfigService.get('theme_color') as string || '#6a1b9a');
    };
    window.addEventListener('linkual_settings_updated', handleConfigUpdate);
    return () => window.removeEventListener('linkual_settings_updated', handleConfigUpdate);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    hasMoved.current = false;
    offset.current = {
      x: e.clientX - position.left,
      y: window.innerHeight - e.clientY - position.bottom
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        e.preventDefault();
        hasMoved.current = true;
        let newLeft = e.clientX - offset.current.x;
        let newBottom = window.innerHeight - e.clientY - offset.current.y;
        newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - 60));
        newBottom = Math.max(0, Math.min(newBottom, window.innerHeight - 60));
        setPosition({ left: newLeft, bottom: newBottom });
      }
    };
    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, position]);

  const handleButtonClick = (e: React.MouseEvent) => {
    if (hasMoved.current) { e.preventDefault(); return; }
    setIsOpen(!isOpen);
  };

  useEffect(() => {
    const handleEvent = (e: any) => {
      const { word, context, source, youtube, autoOpen } = e.detail;
      
      const dateObj = new Date();
      const systemDate = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
      
      const newTask: VocabTask = {
        id: Date.now() + Math.random().toString(36).substring(2, 9),
        word, context, source, youtube, date: systemDate,
        category: selectedCategory, 
        status: 'idle', error: null
      };
      setTasks(prev => [newTask, ...prev]);
      if (autoOpen) setIsOpen(true);
    };
    window.addEventListener('linkual-add-vocab', handleEvent);
    return () => window.removeEventListener('linkual-add-vocab', handleEvent);
  }, [selectedCategory]);

  const handleFetchLlm = (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const apiKey = ConfigService.get('api_key') as string;
    const apiUrl = ConfigService.get('api_url') as string;
    const apiModel = ConfigService.get('api_model') as string;

    if (!apiKey) {
       alert("请先在设置中配置 API Key");
       return;
    }

    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'fetching_llm', error: null, rawJson: '' } : t));

    let generatedJsonStr = '';
    fetchLlmStream({
      apiUrl, apiKey, apiModel,
      systemPrompt: "你是一个翻译和词典助手。请提取目标单词在给定上下文中的含义。必须严格以 JSON 格式输出，不要包含任何 markdown 代码块标记或其他纯文本。\n格式要求：\n{\n  \"pronunciation\": \"音标\",\n  \"definitions\": [\"词性. 解释 1\", \"词性. 解释 2\"],\n  \"explanation\": \"在当前上下文中的准确翻译\"\n}",
      userPrompt: `目标单词：${task.word}\n所在上下文：${task.context}`,
      timeoutSec: 30,
      onData: (chunk) => {
        generatedJsonStr += chunk;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, rawJson: generatedJsonStr } : t));
      },
      onError: (err) => {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'failed', error: err } : t));
      },
      onDone: () => {
        let parsed = {};
        try {
          const jsonRegex = new RegExp("```json\\n([\\s\\S]*?)\\n```");
          const replaceRegex = new RegExp("```json\\n|\\n```", "g");
          const match = generatedJsonStr.match(jsonRegex) || generatedJsonStr.match(/\{[\s\S]*\}/);
          const cleanStr = match ? match[0].replace(replaceRegex, '') : generatedJsonStr;
          parsed = JSON.parse(cleanStr);
        } catch(e) {}
        
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'idle', llmResult: parsed, rawJson: generatedJsonStr } : t));
      }
    });
  };

  const handleSend = (taskId: string, deleteOnSuccess: boolean) => {
    const sendingTask = tasks.find(t => t.id === taskId);
    if (!sendingTask) return;

    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'sending', error: null } : t));

    const serverUrl = ConfigService.get('lan_sync_url') as string;
    
    const payload = {
      word: sendingTask.word,
      context: sendingTask.context,
      source: sendingTask.source,
      youtube: sendingTask.youtube,
      date: sendingTask.date,
      llm_result: sendingTask.llmResult || {}, 
      raw_json: sendingTask.rawJson,
      fetch_llm: false,
      category: sendingTask.category
    };

    fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(async res => {
      if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
      if (deleteOnSuccess) {
        setTasks(prev => prev.filter(t => t.id !== taskId));
      } else {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'success' } : t));
      }
    })
    .catch(err => {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'failed', error: err.message } : t));
    });
  };

  const handleDeleteTask = (taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
  };

  const handleClearAll = () => {
    if (window.confirm("确定清空当前队列中所有的缓存词卡吗？")) {
      setTasks([]);
      localStorage.removeItem('linkual_vocab_queue');
    }
  };

  const pendingCount = tasks.filter(t => t.status !== 'success').length;

  return (
    <div style={{ position: 'fixed', left: `${position.left}px`, bottom: `${position.bottom}px`, zIndex: 2147483647, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', fontFamily: 'sans-serif' }}>
      {isOpen && (
        <div style={{ width: '400px', height: '580px', background: '#fff', borderRadius: '8px', boxShadow: '0 10px 30px rgba(0,0,0,0.2)', border: '1px solid #e4e4e7', display: 'flex', flexDirection: 'column', marginBottom: '12px', overflow: 'hidden' }}>
          
          <div style={{ padding: '12px', borderBottom: '1px solid #e4e4e7', background: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
             <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#333' }}>生词本目录:</label>
                <input 
                  value={selectedCategory} 
                  onChange={e => setSelectedCategory(e.target.value)} 
                  style={{ width: '120px', padding: '4px 8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '12px', outline: 'none' }}
                />
             </div>
             <button onClick={handleClearAll} style={{ border: 'none', background: 'none', color: '#f44336', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}>清空全部队列</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px', background: '#f9f9f9' }}>
            {tasks.length === 0 && <div style={{ textAlign: 'center', color: '#999', marginTop: '40px', fontSize: '13px' }}>暂无待处理单词</div>}
            
            {tasks.map(t => (
              <div key={t.id} style={{ padding: '12px', border: '1px solid #eaeaea', borderRadius: '8px', background: '#fff', boxShadow: '0 2px 5px rgba(0,0,0,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <strong style={{ fontSize: '16px', color: '#333' }}>{t.word}</strong>
                  <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '10px', background: t.status === 'success' ? '#e8f5e9' : t.status === 'failed' ? '#ffebee' : '#e3f2fd', color: t.status === 'success' ? '#4caf50' : t.status === 'failed' ? '#f44336' : '#1976d2' }}>
                    {t.status === 'idle' && (t.llmResult ? '释义已就绪' : '等待操作')}
                    {t.status === 'fetching_llm' && '正在解析...'}
                    {t.status === 'sending' && '发送中...'}
                    {t.status === 'success' && '发送成功'}
                    {t.status === 'failed' && '操作失败'}
                  </span>
                </div>
                
                <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px dashed #eee' }}>
                  {t.context}
                </div>

                <div style={{ fontSize: '11px', color: '#e53935', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{t.youtube ? `▶ YouTube 捕获: ${t.youtube.timestamp}s` : '本地字幕记录'}</span>
                  <span style={{ color: '#888', fontStyle: 'italic', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.source}
                  </span>
                </div>
                
                {t.llmResult && Object.keys(t.llmResult).length > 0 && (
                  <div style={{ background: '#f4f4f5', padding: '8px', borderRadius: '6px', fontSize: '12px', marginBottom: '10px' }}>
                    <div style={{ fontWeight: 'bold', color: '#111' }}>{t.llmResult.pronunciation}</div>
                    <ul style={{ margin: '4px 0', paddingLeft: '16px', color: '#444' }}>
                      {t.llmResult.definitions?.map((d: string, i: number) => <li key={i}>{d}</li>)}
                    </ul>
                    <div style={{ color: '#1976d2', fontStyle: 'italic' }}>翻译: {t.llmResult.explanation}</div>
                  </div>
                )}

                {t.error && <div style={{ color: '#f44336', fontSize: '11px', marginBottom: '8px' }}>{t.error}</div>}

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                  <button 
                    onClick={() => handleFetchLlm(t.id)} 
                    disabled={t.status === 'fetching_llm' || t.status === 'sending'}
                    style={{ flex: '1 1 auto', padding: '6px 10px', background: '#f4f4f5', color: '#333', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                  >
                    请求释义
                  </button>
                  <button onClick={() => handleSend(t.id, true)} style={{ flex: '1 1 auto', padding: '6px 10px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}>发送并删除</button>
                  <button onClick={() => handleSend(t.id, false)} style={{ flex: '1 1 auto', padding: '6px 10px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}>发送并保留</button>
                  <button onClick={() => handleDeleteTask(t.id)} style={{ padding: '6px 12px', background: 'transparent', color: '#f44336', border: '1px solid #f44336', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>丢弃</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <button 
        onMouseDown={handleMouseDown}
        onClick={handleButtonClick}
        title="按住即可拖动面板位置"
        style={{ padding: '12px 20px', background: themeColor, color: '#fff', border: 'none', borderRadius: '30px', boxShadow: '0 6px 16px rgba(0,0,0,0.25)', cursor: isDragging ? 'grabbing' : 'grab', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', fontSize: '14px', userSelect: 'none' }}
      >
        <span>制卡队列 {pendingCount > 0 && <span style={{ background: '#f44336', padding: '2px 8px', borderRadius: '12px', fontSize: '12px', marginLeft: '6px' }}>{pendingCount}</span>}</span>
      </button>
    </div>
  );
};

export default VocabQueue;