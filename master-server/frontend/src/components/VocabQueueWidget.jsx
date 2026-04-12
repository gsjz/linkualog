import React, { useState, useEffect, useRef } from 'react';
import { addVocabulary } from '../api/client';

const ACTIVE_VOCAB_CATEGORY_KEY = 'activeVocabCategory';
const ACTIVE_VOCAB_CATEGORY_EVENT = 'active-vocab-category-updated';

const readStoredActiveVocabularyCategory = () => {
  if (typeof window === 'undefined') return '';
  return String(window.localStorage.getItem('defaultCategory') || '').trim();
};

const getQueueStatusTone = (status) => {
  if (status === 'success') {
    return {
      color: 'var(--ms-success)',
      background: 'var(--ms-success-soft)',
      border: '1px solid rgba(15, 118, 110, 0.16)',
    };
  }

  if (status === 'failed') {
    return {
      color: 'var(--ms-danger)',
      background: 'var(--ms-danger-soft)',
      border: '1px solid rgba(180, 35, 24, 0.14)',
    };
  }

  if (status === 'processing') {
    return {
      color: 'var(--ms-text)',
      background: 'var(--ms-surface-muted)',
      border: '1px solid var(--ms-border)',
    };
  }

  return {
    color: 'var(--ms-text-muted)',
    background: 'rgba(255, 255, 255, 0.9)',
    border: '1px solid var(--ms-border)',
  };
};

export default function VocabQueueWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('manual'); 
  const [filter, setFilter] = useState('all'); 
  const [tasks, setTasks] = useState([]);
  const [activeTaskId, setActiveTaskId] = useState('');

  const [mWord, setMWord] = useState('');
  const [mContext, setMContext] = useState('');
  const [mSource, setMSource] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(readStoredActiveVocabularyCategory);
  const [categoryError, setCategoryError] = useState('');

  const [position, setPosition] = useState({ left: 24, bottom: 24 });
  const [isDragging, setIsDragging] = useState(false);
  const offset = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);
  const isMountedRef = useRef(true);
  const nextTaskIdRef = useRef(1);

  const categoryRef = useRef(selectedCategory);
  const createQueueTaskId = () => {
    const nextId = nextTaskIdRef.current;
    nextTaskIdRef.current += 1;
    return `queue-task-${nextId}`;
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    categoryRef.current = selectedCategory;
  }, [selectedCategory]);

  useEffect(() => {
    const normalizedCategory = String(selectedCategory || '').trim();
    localStorage.setItem(ACTIVE_VOCAB_CATEGORY_KEY, normalizedCategory);
    window.dispatchEvent(new CustomEvent(ACTIVE_VOCAB_CATEGORY_EVENT, {
      detail: { category: normalizedCategory },
    }));
  }, [selectedCategory]);

  useEffect(() => {
    const handleConfigUpdate = () => {
      setSelectedCategory(String(localStorage.getItem('defaultCategory') || '').trim());
      setCategoryError('');
    };
    const handleDefaultCategoryUpdate = () => handleConfigUpdate();
    window.addEventListener('config-updated', handleConfigUpdate);
    window.addEventListener('default-category-updated', handleDefaultCategoryUpdate);
    return () => {
      window.removeEventListener('config-updated', handleConfigUpdate);
      window.removeEventListener('default-category-updated', handleDefaultCategoryUpdate);
    };
  }, []);

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    hasMoved.current = false;
    offset.current = {
      x: e.clientX - position.left,
      y: window.innerHeight - e.clientY - position.bottom
    };
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
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
  }, [isDragging]);

  const handleButtonClick = (e) => {
    if (hasMoved.current) {
      e.preventDefault();
      return;
    }
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setActiveTab('manual');
    setIsOpen(true);
  };

  useEffect(() => {
    const handleEvent = (e) => {
      const category = String(categoryRef.current || '').trim();
      if (!category) {
        setCategoryError('请先在右上角设置默认生词本目录，不能直接保存到 data/');
        setActiveTab('manual');
        setIsOpen(true);
        return;
      }
      const { word, context, source, fetchLlm, focusPositions } = e.detail;
      const newTask = {
        id: createQueueTaskId(),
        word, context, source, fetchLlm,
        focusPositions: Array.isArray(focusPositions) ? focusPositions : [],
        category,
        status: 'pending',
        error: null
      };
      setTasks(prev => [newTask, ...prev]);
    };
    window.addEventListener('add-vocab-task', handleEvent);
    return () => window.removeEventListener('add-vocab-task', handleEvent);
  }, []);

  useEffect(() => {
    if (activeTaskId) return undefined;

    const pendingTask = tasks.find((t) => t.status === 'pending');
    if (!pendingTask) return undefined;

    queueMicrotask(() => {
      if (!isMountedRef.current) return;
      setActiveTaskId(pendingTask.id);
      setTasks((prev) => prev.map((t) => (t.id === pendingTask.id ? { ...t, status: 'processing' } : t)));
    });

    addVocabulary(
      pendingTask.word,
      pendingTask.context,
      pendingTask.source,
      pendingTask.fetchLlm,
      'all',
      pendingTask.category,
      pendingTask.focusPositions
    )
      .then(() => {
        if (!isMountedRef.current) return;
        setTasks((prev) => prev.map((t) => (t.id === pendingTask.id ? { ...t, status: 'success' } : t)));
        setActiveTaskId((current) => (current === pendingTask.id ? '' : current));
      })
      .catch((err) => {
        if (!isMountedRef.current) return;
        setTasks((prev) => prev.map((t) => (t.id === pendingTask.id ? { ...t, status: 'failed', error: err.message } : t)));
        setActiveTaskId((current) => (current === pendingTask.id ? '' : current));
      });

    return undefined;
  }, [activeTaskId, tasks]); 

  const handleManualAdd = (e) => {
    e.preventDefault();
    if (!mWord) return;
    const category = String(selectedCategory || '').trim();
    if (!category) {
      setCategoryError('请先在右上角设置默认生词本目录，必须使用 data/文件夹/');
      return;
    }
    const newTask = {
      id: createQueueTaskId(),
      word: mWord, context: mContext, source: mSource, fetchLlm: false,
      focusPositions: [],
      category,
      status: 'pending', error: null
    };
    setTasks(prev => [newTask, ...prev]);
    setCategoryError('');
    setMWord(''); setMContext(''); setMSource('');
  };

  const handleRetry = (id) => setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'pending', error: null } : t));

  const filteredTasks = tasks.filter(t => filter === 'all' || t.status === filter);
  const pendingCount = tasks.filter(t => t.status === 'pending' || t.status === 'processing').length;

  return (
    <div className="vocab-queue" style={{ position: 'fixed', left: `${position.left}px`, bottom: `${position.bottom}px`, zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      {isOpen && (
        <div className="queue-panel" style={{ width: 'min(368px, calc(100vw - 28px))', height: 'min(560px, calc(100vh - 116px))', background: '#fff', borderRadius: '6px', boxShadow: 'none', border: '1px solid var(--ms-border)', display: 'flex', flexDirection: 'column', marginBottom: '12px', overflow: 'hidden' }}>
          
          <div className="queue-panel-header" style={{ padding: '12px', borderBottom: '1px solid var(--ms-border)', background: 'var(--ms-surface-muted)', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
             <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--ms-text)', whiteSpace: 'nowrap' }}>目标目录</span>
             <span
               className="queue-category-value"
               style={{
                 maxWidth: '70%',
                 padding: '7px 10px',
                 border: `1px solid ${categoryError ? 'var(--ms-danger)' : 'var(--ms-border)'}`,
                 borderRadius: '6px',
                 fontSize: '13px',
                 background: '#fff',
                 color: selectedCategory ? 'var(--ms-text)' : 'var(--ms-text-faint)',
                 whiteSpace: 'nowrap',
                 overflow: 'hidden',
                 textOverflow: 'ellipsis',
               }}
               title={selectedCategory || '请先在右上角设置默认生词本目录'}
             >
               {selectedCategory || '请先在右上角设置默认生词本目录'}
             </span>
          </div>
          {categoryError ? (
            <div className="queue-category-error" style={{ padding: '8px 12px', borderBottom: '1px solid var(--ms-border)', color: 'var(--ms-danger)', fontSize: '12px', background: 'var(--ms-danger-soft)' }}>
              {categoryError}
            </div>
          ) : null}

          <div className="queue-tabs" style={{ display: 'flex', borderBottom: '1px solid var(--ms-border)', background: 'var(--ms-surface-muted)' }}>
            <button className={`queue-tab-button${activeTab === 'queue' ? ' is-active' : ''}`} onClick={() => setActiveTab('queue')} style={{ flex: 1, padding: '12px', border: 'none', background: activeTab === 'queue' ? '#fff' : 'transparent', fontWeight: activeTab === 'queue' ? '600' : '400', cursor: 'pointer', borderBottom: activeTab === 'queue' ? '2px solid var(--ms-text)' : '2px solid transparent' }}>任务队列 ({tasks.length})</button>
            <button className={`queue-tab-button${activeTab === 'manual' ? ' is-active' : ''}`} onClick={() => setActiveTab('manual')} style={{ flex: 1, padding: '12px', border: 'none', background: activeTab === 'manual' ? '#fff' : 'transparent', fontWeight: activeTab === 'manual' ? '600' : '400', cursor: 'pointer', borderBottom: activeTab === 'manual' ? '2px solid var(--ms-text)' : '2px solid transparent' }}>手动录入</button>
          </div>

          {activeTab === 'queue' && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              <div className="queue-filter-bar" style={{ padding: '10px 16px', borderBottom: '1px solid var(--ms-border)', display: 'flex', gap: '8px', fontSize: '12px', flexWrap: 'wrap' }}>
                {['all', 'processing', 'success', 'failed'].map(f => (
                  <button
                    key={f}
                    type="button"
                    className={`queue-filter-chip${filter === f ? ' is-active' : ''}`}
                    onClick={() => setFilter(f)}
                    style={{ cursor: 'pointer', padding: '5px 10px', borderRadius: '4px', background: filter === f ? 'var(--ms-surface-strong)' : 'transparent', border: filter === f ? '1px solid var(--ms-border)' : '1px solid transparent', color: filter === f ? 'var(--ms-text)' : 'var(--ms-text-muted)' }}
                  >
                    {f === 'all' ? '全部' : f === 'processing' ? '处理中' : f === 'success' ? '成功' : '失败'}
                  </button>
                ))}
              </div>
              
              <div className="queue-list" style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {filteredTasks.length === 0 && <div className="queue-empty" style={{ textAlign: 'center', color: '#a1a1aa', marginTop: '40px', fontSize: '13px' }}>暂无任务</div>}
                {filteredTasks.map(t => {
                  const statusTone = getQueueStatusTone(t.status);

                  return (
                  <div key={t.id} className="queue-task-card" style={{ ...statusTone, padding: '12px', borderRadius: '6px', fontSize: '13px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <strong className="queue-task-word" style={{ fontSize: '14px', color: 'var(--ms-text)' }}>{t.word}</strong>
                      <span className="queue-task-status" style={{ fontSize: '12px', color: statusTone.color, fontWeight: 600 }}>
                        {t.status === 'pending' && '等待中'}
                        {t.status === 'processing' && '处理中...'}
                        {t.status === 'success' && '成功'}
                        {t.status === 'failed' && '失败'}
                      </span>
                    </div>
                    <div className="queue-task-context" style={{ color: 'var(--ms-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '8px' }}>{t.context}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="queue-task-mode" style={{ fontSize: '11px', background: 'rgba(255, 255, 255, 0.9)', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(213, 221, 208, 0.72)', color: 'var(--ms-text-muted)' }}>{t.fetchLlm ? '解析' : '仅保存'}</span>
                      <div className="queue-task-actions" style={{ display: 'flex', gap: '8px' }}>
                        {t.status === 'failed' && <button className="queue-inline-action" onClick={() => handleRetry(t.id)} style={{ padding: '2px 8px', fontSize: '12px', background: 'var(--ms-text)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>重试</button>}
                      </div>
                    </div>
                    {t.error && <div className="queue-task-error" style={{ color: 'var(--ms-danger)', fontSize: '11px', marginTop: '8px' }}>{t.error}</div>}
                  </div>
                )})}
              </div>
            </div>
          )}

          {activeTab === 'manual' && (
            <form className="queue-manual-form" onSubmit={handleManualAdd} style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, overflowY: 'auto' }}>
              <div className="queue-field" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '13px', fontWeight: '500' }}>Word (Text)</label>
                <input className="queue-field-input" required value={mWord} onChange={e => setMWord(e.target.value)} style={{ padding: '10px', border: '1px solid var(--ms-border)', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.92)' }} placeholder="如: abandon" />
              </div>
              <div className="queue-field" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '13px', fontWeight: '500' }}>Context</label>
                <textarea className="queue-field-input queue-field-textarea" required value={mContext} onChange={e => setMContext(e.target.value)} style={{ padding: '10px', border: '1px solid var(--ms-border)', borderRadius: '6px', height: '88px', resize: 'vertical', background: 'rgba(255, 255, 255, 0.92)' }} placeholder="所在的完整句子..." />
              </div>
              <div className="queue-field" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '13px', fontWeight: '500' }}>Source (可选)</label>
                <input className="queue-field-input" value={mSource} onChange={e => setMSource(e.target.value)} style={{ padding: '10px', border: '1px solid var(--ms-border)', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.92)' }} placeholder="来源标注..." />
              </div>
              <button type="submit" className="master-primary-button queue-submit-button" style={{ marginTop: 'auto' }}>添加到处理队列</button>
            </form>
          )}
        </div>
      )}

      <button 
        className="queue-fab"
        onMouseDown={handleMouseDown}
        onClick={handleButtonClick}
        title="按住即可拖动面板位置"
        style={{ padding: '12px 20px', background: '#111111', color: '#fff', border: 'none', borderRadius: '6px', boxShadow: 'none', cursor: isDragging ? 'grabbing' : 'grab', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '600', userSelect: 'none' }}
      >
        <span>词库队列 {pendingCount > 0 && <span className="queue-fab-count" style={{ padding: '2px 6px', borderRadius: '4px', fontSize: '11px', marginLeft: '4px' }}>{pendingCount}</span>}</span>
      </button>

    </div>
  );
}
