import React, { useState, useEffect, useRef } from 'react';
import { ConfigService } from '../services/configService';
import { fetchLlmStream } from '../services/llmApi';
import { requestJson } from '../services/jsonApi';

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
  llmResult?: VocabLlmResult;
}

interface VocabLlmResult {
  definitions?: string[];
  examples?: Array<{
    text?: string;
    explanation?: string;
    focusWords?: string[];
  }>;
  explanation?: string;
  context_translation?: string;
}

const VOCAB_LLM_SYSTEM_PROMPT = `你是一个专业的英文翻译和词典 API 引擎。
请根据目标词或短语及其上下文，生成适合写入生词本的 JSON。

要求：
1. 不要输出 pronunciation、音标或任何发音字段。
2. definitions 只给目标词在当前上下文中最贴切的 1-3 条中文释义，格式为“词性. 中文释义”，释义必须以中文为主，不能是纯英文。
3. examples 必须包含且只包含一个例句对象；text 必须与用户提供的上下文完全一致。
4. examples[0].explanation 必须是自然、完整的中文解释，既翻译上下文，也点明目标词在此处的具体含义。
5. examples[0].focusWords 只放真正需要聚焦的词或最小必要词组，优先使用上下文中出现的原始形态。
6. 只输出合法 JSON，不要输出 markdown、代码块、注释或额外说明。

JSON 格式：
{
  "definitions": ["vt. 放弃，抛弃（在此语境下）"],
  "examples": [
    {
      "text": "原始上下文句子",
      "explanation": "自然中文解释。",
      "focusWords": ["目标词"]
    }
  ]
}`;

const parseLlmJson = (rawText: string): unknown => {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1] : (trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed);
  return JSON.parse(candidate);
};

const sanitizeLlmResult = (value: unknown): VocabLlmResult => {
  if (!value || typeof value !== 'object') return {};

  const raw = value as Record<string, unknown>;
  const result: VocabLlmResult = {};

  if (Array.isArray(raw.definitions)) {
    const definitions = raw.definitions
      .map(item => String(item || '').trim())
      .filter(Boolean);
    if (definitions.length > 0) result.definitions = definitions;
  }

  if (Array.isArray(raw.examples)) {
    const examples = raw.examples
      .filter(item => item && typeof item === 'object')
      .map((item) => {
        const rawExample = item as Record<string, unknown>;
        const example: NonNullable<VocabLlmResult['examples']>[number] = {};
        const text = String(rawExample.text || '').trim();
        const explanation = String(rawExample.explanation || '').trim();
        const focusWords = Array.isArray(rawExample.focusWords)
          ? rawExample.focusWords.map(word => String(word || '').trim()).filter(Boolean)
          : [];

        if (text) example.text = text;
        if (explanation) example.explanation = explanation;
        if (focusWords.length > 0) example.focusWords = focusWords;
        return example;
      })
      .filter(example => example.text || example.explanation || example.focusWords?.length);

    if (examples.length > 0) result.examples = examples;
  }

  const explanation = String(raw.explanation || '').trim();
  if (explanation) result.explanation = explanation;

  const contextTranslation = String(raw.context_translation || '').trim();
  if (contextTranslation) result.context_translation = contextTranslation;

  return result;
};

const getLlmExplanation = (result?: VocabLlmResult) => (
  result?.examples?.find(example => example.explanation)?.explanation
  || result?.explanation
  || result?.context_translation
  || ''
);

const hasUsableLlmResult = (result?: VocabLlmResult) => Boolean(
  result?.definitions?.length
  || result?.examples?.length
  || getLlmExplanation(result)
);

const canSendTask = (task: VocabTask) => task.status === 'idle' || task.status === 'failed';

const LlmResultPreview: React.FC<{ result?: VocabLlmResult }> = ({ result }) => {
  if (!hasUsableLlmResult(result)) return null;

  const explanation = getLlmExplanation(result);

  return (
    <div style={{ background: '#f4f4f5', padding: '8px', borderRadius: '6px', fontSize: '12px', marginBottom: '10px' }}>
      {result?.definitions?.length ? (
        <ul style={{ margin: '4px 0', paddingLeft: '16px', color: '#444' }}>
          {result.definitions.map((d: string, i: number) => <li key={i}>{d}</li>)}
        </ul>
      ) : null}
      {explanation ? (
        <div style={{ color: '#1976d2', fontStyle: 'italic' }}>解析: {explanation}</div>
      ) : null}
    </div>
  );
};

const sanitizeTask = (task: VocabTask): VocabTask => {
  const sanitizedResult = sanitizeLlmResult(task.llmResult);
  return {
    ...task,
    llmResult: hasUsableLlmResult(sanitizedResult) ? sanitizedResult : undefined,
  };
};

const VocabQueue: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isBulkSending, setIsBulkSending] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(ConfigService.get('lan_action') as string || 'Video_Sync');
  const [themeColor, setThemeColor] = useState(ConfigService.get('theme_color') as string || '#6a1b9a');

  const [tasks, setTasks] = useState<VocabTask[]>(() => {
    try {
      const saved = localStorage.getItem('linkual_vocab_queue');
      if (saved) return JSON.parse(saved).map(sanitizeTask);
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
          setTasks(JSON.parse(e.newValue).map(sanitizeTask));
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
      const { word, context, source, youtube } = e.detail;
      
      const dateObj = new Date();
      const systemDate = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
      
      const newTask: VocabTask = {
        id: Date.now() + Math.random().toString(36).substring(2, 9),
        word, context, source, youtube, date: systemDate,
        category: selectedCategory, 
        status: 'idle', error: null
      };
      setTasks(prev => [newTask, ...prev]);
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
      systemPrompt: VOCAB_LLM_SYSTEM_PROMPT,
      userPrompt: `目标词或短语：${task.word}\n上下文：${task.context}`,
      timeoutSec: 30,
      onData: (chunk) => {
        generatedJsonStr += chunk;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, rawJson: generatedJsonStr } : t));
      },
      onError: (err) => {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'failed', error: err } : t));
      },
      onDone: () => {
        let parsed: VocabLlmResult = {};
        try {
          parsed = sanitizeLlmResult(parseLlmJson(generatedJsonStr));
        } catch(e) {
          const message = e instanceof Error ? e.message : String(e);
          setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'failed', error: `LLM 返回 JSON 解析失败: ${message}`, rawJson: generatedJsonStr } : t));
          return;
        }

        if (!hasUsableLlmResult(parsed)) {
          setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'failed', error: 'LLM 未返回可用释义 JSON', rawJson: generatedJsonStr } : t));
          return;
        }

        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'idle', llmResult: parsed, rawJson: generatedJsonStr } : t));
      }
    });
  };

  const sendTaskToServer = (sendingTask: VocabTask) => {
    const serverUrl = ConfigService.get('lan_sync_url') as string;

    const payload = {
      word: sendingTask.word,
      context: sendingTask.context,
      source: sendingTask.source,
      youtube: sendingTask.youtube,
      date: sendingTask.date,
      llm_result: sanitizeLlmResult(sendingTask.llmResult),
      fetch_llm: false,
      category: sendingTask.category
    };

    console.info('[Linkual] 发送生词到后端:', serverUrl, payload);

    return requestJson({
      url: serverUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 15000,
    });
  };

  const handleSend = (taskId: string, deleteOnSuccess: boolean) => {
    const sendingTask = tasks.find(t => t.id === taskId);
    if (!sendingTask || !canSendTask(sendingTask)) return;

    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'sending', error: null } : t));

    sendTaskToServer(sendingTask)
    .then(() => {
      console.info('[Linkual] 生词发送成功:', sendingTask.word);
      if (deleteOnSuccess) {
        setTasks(prev => prev.filter(t => t.id !== taskId));
      } else {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'success' } : t));
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : '请求异常';
      console.error('[Linkual] 生词发送失败:', message, { task: sendingTask });
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'failed', error: message } : t));
    });
  };

  const handleSendAllAndDelete = async () => {
    const tasksToSend = tasks.filter(canSendTask);
    if (tasksToSend.length === 0 || isBulkSending) return;

    setIsBulkSending(true);
    setTasks(prev => prev.map(t => canSendTask(t) ? { ...t, status: 'sending', error: null } : t));

    try {
      for (const task of tasksToSend) {
        try {
          await sendTaskToServer(task);
          console.info('[Linkual] 生词发送成功:', task.word);
          setTasks(prev => prev.filter(t => t.id !== task.id));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : '请求异常';
          console.error('[Linkual] 生词发送失败:', message, { task });
          setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'failed', error: message } : t));
        }
      }
    } finally {
      setIsBulkSending(false);
    }
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
  const sendableCount = tasks.filter(canSendTask).length;
  const bulkSendDisabled = isBulkSending || sendableCount === 0;

  return (
    <div style={{ position: 'fixed', left: `${position.left}px`, bottom: `${position.bottom}px`, zIndex: 2147483647, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', fontFamily: 'sans-serif' }}>
      {isOpen && (
        <div style={{ width: '400px', height: '580px', background: '#fff', borderRadius: '8px', boxShadow: '0 10px 30px rgba(0,0,0,0.2)', border: '1px solid #e4e4e7', display: 'flex', flexDirection: 'column', marginBottom: '12px', overflow: 'hidden' }}>
          
          <div style={{ padding: '12px', borderBottom: '1px solid #e4e4e7', background: '#fafafa', display: 'flex', flexDirection: 'column', gap: '8px' }}>
             <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#333' }}>生词本目录:</label>
                <input 
                  value={selectedCategory} 
                  onChange={e => setSelectedCategory(e.target.value)} 
                  style={{ width: '120px', padding: '4px 8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '12px', outline: 'none' }}
                />
             </div>
             <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
               <button
                 onClick={handleSendAllAndDelete}
                 disabled={bulkSendDisabled}
                 style={{ border: 'none', background: bulkSendDisabled ? '#a7f3d0' : '#10b981', color: '#fff', cursor: bulkSendDisabled ? 'not-allowed' : 'pointer', fontSize: '12px', fontWeight: 'bold', borderRadius: '4px', padding: '5px 9px' }}
               >
                 {isBulkSending ? '批量发送中...' : '一键发送并删除'}
               </button>
               <button onClick={handleClearAll} style={{ border: 'none', background: 'none', color: '#f44336', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}>清空全部队列</button>
             </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px', background: '#f9f9f9' }}>
            {tasks.length === 0 && <div style={{ textAlign: 'center', color: '#999', marginTop: '40px', fontSize: '13px' }}>暂无待处理单词</div>}
            
            {tasks.map(t => (
              <div key={t.id} style={{ padding: '12px', border: '1px solid #eaeaea', borderRadius: '8px', background: '#fff', boxShadow: '0 2px 5px rgba(0,0,0,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <strong style={{ fontSize: '16px', color: '#333' }}>{t.word}</strong>
                  <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '10px', background: t.status === 'success' ? '#e8f5e9' : t.status === 'failed' ? '#ffebee' : '#e3f2fd', color: t.status === 'success' ? '#4caf50' : t.status === 'failed' ? '#f44336' : '#1976d2' }}>
                    {t.status === 'idle' && (hasUsableLlmResult(t.llmResult) ? '释义已就绪' : '等待操作')}
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
                
                <LlmResultPreview result={t.llmResult} />

                {t.error && <div style={{ color: '#f44336', fontSize: '11px', marginBottom: '8px' }}>{t.error}</div>}

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                  <button 
                    onClick={() => handleFetchLlm(t.id)} 
                    disabled={t.status === 'fetching_llm' || t.status === 'sending'}
                    style={{ flex: '1 1 auto', padding: '6px 10px', background: '#f4f4f5', color: '#333', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                  >
                    请求释义
                  </button>
                  <button
                    onClick={() => handleSend(t.id, true)}
                    disabled={!canSendTask(t)}
                    style={{ flex: '1 1 auto', padding: '6px 10px', background: canSendTask(t) ? '#10b981' : '#a7f3d0', color: '#fff', border: 'none', borderRadius: '4px', cursor: canSendTask(t) ? 'pointer' : 'not-allowed', fontSize: '12px', fontWeight: 'bold' }}
                  >
                    发送并删除
                  </button>
                  <button
                    onClick={() => handleSend(t.id, false)}
                    disabled={!canSendTask(t)}
                    style={{ flex: '1 1 auto', padding: '6px 10px', background: canSendTask(t) ? '#3b82f6' : '#bfdbfe', color: '#fff', border: 'none', borderRadius: '4px', cursor: canSendTask(t) ? 'pointer' : 'not-allowed', fontSize: '12px', fontWeight: 'bold' }}
                  >
                    发送并保留
                  </button>
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
