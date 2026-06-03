import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addVocabulary } from '../api/client';
import UiIcon from './UiIcon';

const ACTIVE_VOCAB_CATEGORY_KEY = 'activeVocabCategory';
const ACTIVE_VOCAB_CATEGORY_EVENT = 'active-vocab-category-updated';
const ADD_VOCAB_CATEGORY_KEY = 'addVocabularyCategory';
const ADD_VOCAB_CATEGORY_EVENT = 'add-vocabulary-category-updated';
const LEGACY_UPLOAD_DEFAULT_CATEGORY_KEY = 'uploadDefaultCategory';
const LEGACY_DEFAULT_CATEGORY_KEY = 'defaultCategory';

const normalizeCategoryValue = (value) => String(value || '').trim();

const readStoredActiveVocabularyCategory = () => {
  if (typeof window === 'undefined') return '';
  const storedAddCategory = window.localStorage.getItem(ADD_VOCAB_CATEGORY_KEY);
  if (storedAddCategory !== null) return normalizeCategoryValue(storedAddCategory);
  const storedUploadCategory = window.localStorage.getItem(LEGACY_UPLOAD_DEFAULT_CATEGORY_KEY);
  if (storedUploadCategory !== null) return normalizeCategoryValue(storedUploadCategory);
  return normalizeCategoryValue(window.localStorage.getItem(LEGACY_DEFAULT_CATEGORY_KEY));
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

export default function VocabQueueWidget({
  embedded = false,
  open = null,
  onOpenChange = null,
  defaultOpen = false,
  categories = [],
  selectedCategory: controlledCategory = null,
  onSelectedCategoryChange = null,
  onStatsChange = null,
} = {}) {
  const isControlledOpen = typeof open === 'boolean';
  const normalizedControlledCategory = controlledCategory === null || controlledCategory === undefined
    ? null
    : normalizeCategoryValue(controlledCategory);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = isControlledOpen ? open : internalOpen;
  const [activeTab, setActiveTab] = useState('manual'); 
  const [filter, setFilter] = useState('all'); 
  const [tasks, setTasks] = useState([]);
  const [activeTaskId, setActiveTaskId] = useState('');

  const [mWord, setMWord] = useState('');
  const [mContext, setMContext] = useState('');
  const [mSource, setMSource] = useState('');
  const [mContextLocked, setMContextLocked] = useState(false);
  const [mSourceLocked, setMSourceLocked] = useState(false);
  const [mIntentionalBlank, setMIntentionalBlank] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(() => (
    normalizedControlledCategory ?? readStoredActiveVocabularyCategory()
  ));
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

  const normalizedCategories = useMemo(() => (
    [...new Set((Array.isArray(categories) ? categories : [])
      .map(normalizeCategoryValue)
      .filter(Boolean))]
  ), [categories]);
  const selectedCategoryMissing = selectedCategory && !normalizedCategories.includes(selectedCategory);

  const setQueueOpen = useCallback((nextOpen) => {
    const resolvedOpen = typeof nextOpen === 'function' ? Boolean(nextOpen(isOpen)) : Boolean(nextOpen);
    if (!isControlledOpen) {
      setInternalOpen(resolvedOpen);
    }
    if (onOpenChange) {
      onOpenChange(resolvedOpen);
    }
  }, [isControlledOpen, isOpen, onOpenChange]);

  const handleSelectedCategoryChange = useCallback((value) => {
    const nextCategory = normalizeCategoryValue(value);
    setSelectedCategory(nextCategory);
    setCategoryError('');

    if (onSelectedCategoryChange) {
      onSelectedCategoryChange(nextCategory);
      return;
    }

    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ADD_VOCAB_CATEGORY_KEY, nextCategory);
    window.localStorage.removeItem(LEGACY_UPLOAD_DEFAULT_CATEGORY_KEY);
    window.dispatchEvent(new CustomEvent(ADD_VOCAB_CATEGORY_EVENT, {
      detail: { category: nextCategory },
    }));
  }, [onSelectedCategoryChange]);

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
    if (typeof window === 'undefined') return;
    localStorage.setItem(ACTIVE_VOCAB_CATEGORY_KEY, normalizedCategory);
    window.dispatchEvent(new CustomEvent(ACTIVE_VOCAB_CATEGORY_EVENT, {
      detail: { category: normalizedCategory },
    }));
  }, [selectedCategory]);

  useEffect(() => {
    const handleConfigUpdate = () => {
      setSelectedCategory(readStoredActiveVocabularyCategory());
      setCategoryError('');
    };
    const handleDefaultCategoryUpdate = () => handleConfigUpdate();
    window.addEventListener(ADD_VOCAB_CATEGORY_EVENT, handleDefaultCategoryUpdate);
    return () => {
      window.removeEventListener(ADD_VOCAB_CATEGORY_EVENT, handleDefaultCategoryUpdate);
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
      setQueueOpen(false);
      return;
    }
    setActiveTab('manual');
    setQueueOpen(true);
  };

  useEffect(() => {
    const handleEvent = (e) => {
      const requestedCategory = normalizeCategoryValue(e?.detail?.category);
      const category = requestedCategory || String(categoryRef.current || '').trim();
      if (!category) {
        setCategoryError('先选择目标目录，避免保存到 data/ 根目录。');
        setActiveTab('manual');
        setQueueOpen(true);
        return;
      }
      if (requestedCategory) {
        setSelectedCategory(requestedCategory);
        setCategoryError('');
      }
      const { word, context, source, fetchLlm, focusPositions, intentionalBlank } = e.detail;
      const newTask = {
        id: createQueueTaskId(),
        word, context, source, fetchLlm,
        focusPositions: Array.isArray(focusPositions) ? focusPositions : [],
        intentionalBlank: Boolean(intentionalBlank),
        category,
        status: 'pending',
        error: null
      };
      setTasks(prev => [newTask, ...prev]);
    };
    window.addEventListener('add-vocab-task', handleEvent);
    return () => window.removeEventListener('add-vocab-task', handleEvent);
  }, [setQueueOpen]);

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
      pendingTask.focusPositions,
      pendingTask.intentionalBlank
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
      setCategoryError('先选择目标目录。');
      return;
    }
    const newTask = {
      id: createQueueTaskId(),
      word: mWord, context: mContext, source: mSource, fetchLlm: false,
      focusPositions: [],
      intentionalBlank: mIntentionalBlank,
      category,
      status: 'pending', error: null
    };
    setTasks(prev => [newTask, ...prev]);
    setCategoryError('');
    setMWord('');
    if (!mContextLocked) setMContext('');
    if (!mSourceLocked) setMSource('');
  };

  const handleRetry = (id) => setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'pending', error: null } : t));

  const filteredTasks = tasks.filter(t => filter === 'all' || t.status === filter);
  const pendingCount = tasks.filter(t => t.status === 'pending' || t.status === 'processing').length;
  const failedCount = tasks.filter(t => t.status === 'failed').length;

  useEffect(() => {
    if (!onStatsChange) return;
    onStatsChange({
      total: tasks.length,
      pending: pendingCount,
      failed: failedCount,
    });
  }, [failedCount, onStatsChange, pendingCount, tasks.length]);

  const panelNode = isOpen ? (
    <div className="queue-panel" style={{ width: embedded ? 'min(360px, calc(100vw - 28px))' : 'min(368px, calc(100vw - 28px))', height: embedded ? 'min(500px, calc(100vh - 104px))' : 'min(560px, calc(100vh - 116px))', background: '#fff', borderRadius: '6px', boxShadow: 'none', border: '1px solid var(--ms-border)', display: 'flex', flexDirection: 'column', marginBottom: embedded ? 0 : '12px', overflow: 'hidden' }}>

      <div className="queue-panel-header" style={{ padding: '10px 12px', borderBottom: '1px solid var(--ms-border)', background: 'var(--ms-surface-muted)', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
         <div className="queue-panel-title" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0, fontSize: '13px', fontWeight: '600', color: 'var(--ms-text)', whiteSpace: 'nowrap' }}>
           <UiIcon name="book" size={16} />
           <span>词库</span>
           {pendingCount > 0 ? <span className="queue-fab-count">{pendingCount}</span> : null}
         </div>
         <label className="queue-category-picker" style={{ minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: '6px' }} title="加词保存目录">
           <UiIcon name="folder" size={15} />
           <select
             className="queue-category-select"
             value={selectedCategory}
             onChange={(e) => handleSelectedCategoryChange(e.target.value)}
             aria-label="加词保存目录"
             style={{
               maxWidth: embedded ? '190px' : '170px',
               height: '30px',
               padding: '0 8px',
               border: `1px solid ${categoryError ? 'var(--ms-danger)' : 'var(--ms-border)'}`,
               borderRadius: '6px',
               fontSize: '12px',
               background: '#fff',
               color: selectedCategory ? 'var(--ms-text)' : 'var(--ms-text-faint)',
             }}
           >
             <option value="">选择目录</option>
             {selectedCategoryMissing ? <option value={selectedCategory}>{selectedCategory}</option> : null}
             {normalizedCategories.map((category) => (
               <option key={category} value={category}>{category}</option>
             ))}
           </select>
         </label>
         {embedded ? (
           <button type="button" className="task-icon-button queue-close-button" aria-label="关闭词库工具" onClick={() => setQueueOpen(false)}>
             <UiIcon name="close" size={16} />
           </button>
         ) : null}
      </div>
      {categoryError ? (
        <div className="queue-category-error" style={{ padding: '8px 12px', borderBottom: '1px solid var(--ms-border)', color: 'var(--ms-danger)', fontSize: '12px', background: 'var(--ms-danger-soft)' }}>
          {categoryError}
        </div>
      ) : null}

      <div className="queue-tabs" style={{ display: 'flex', borderBottom: '1px solid var(--ms-border)', background: 'var(--ms-surface-muted)' }}>
        <button className={`queue-tab-button${activeTab === 'queue' ? ' is-active' : ''}`} onClick={() => setActiveTab('queue')} style={{ flex: 1, padding: '10px 12px', border: 'none', background: activeTab === 'queue' ? '#fff' : 'transparent', fontWeight: activeTab === 'queue' ? '600' : '400', cursor: 'pointer', borderBottom: activeTab === 'queue' ? '2px solid var(--ms-text)' : '2px solid transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          <UiIcon name="list" size={14} />
          <span>队列</span>
        </button>
        <button className={`queue-tab-button${activeTab === 'manual' ? ' is-active' : ''}`} onClick={() => setActiveTab('manual')} style={{ flex: 1, padding: '10px 12px', border: 'none', background: activeTab === 'manual' ? '#fff' : 'transparent', fontWeight: activeTab === 'manual' ? '600' : '400', cursor: 'pointer', borderBottom: activeTab === 'manual' ? '2px solid var(--ms-text)' : '2px solid transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          <UiIcon name="edit" size={14} />
          <span>录入</span>
        </button>
      </div>

      {activeTab === 'queue' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div className="queue-filter-bar" style={{ padding: '8px 12px', borderBottom: '1px solid var(--ms-border)', display: 'flex', gap: '8px', fontSize: '12px', flexWrap: 'wrap' }}>
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
          
          <div className="queue-list" style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {filteredTasks.length === 0 && <div className="queue-empty" style={{ textAlign: 'center', color: '#a1a1aa', marginTop: '28px', fontSize: '13px' }}>暂无任务</div>}
            {filteredTasks.map(t => {
              const statusTone = getQueueStatusTone(t.status);

              return (
              <div key={t.id} className="queue-task-card" style={{ ...statusTone, padding: '12px', borderRadius: '6px', fontSize: '13px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', gap: '10px' }}>
                  <strong className="queue-task-word" style={{ fontSize: '14px', color: 'var(--ms-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.word}</strong>
                  <span className="queue-task-status" style={{ fontSize: '12px', color: statusTone.color, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {t.status === 'pending' && '等待中'}
                    {t.status === 'processing' && '处理中...'}
                    {t.status === 'success' && '成功'}
                    {t.status === 'failed' && '失败'}
                  </span>
                </div>
                <div className="queue-task-context" style={{ color: 'var(--ms-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '8px' }}>{t.context}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="queue-task-mode" style={{ fontSize: '11px', background: 'rgba(255, 255, 255, 0.9)', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(213, 221, 208, 0.72)', color: 'var(--ms-text-muted)' }}>{t.intentionalBlank ? '留白保存' : t.fetchLlm ? '解析' : '仅保存'}</span>
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
        <form className="queue-manual-form" onSubmit={handleManualAdd} style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, overflowY: 'auto' }}>
          <div className="queue-field" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '13px', fontWeight: '500' }}>词条</label>
            <input className="queue-field-input" required value={mWord} onChange={e => setMWord(e.target.value)} style={{ padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.92)' }} placeholder="abandon" />
          </div>
          <div className="queue-field" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div className="queue-field-head">
              <label style={{ fontSize: '13px', fontWeight: '500' }}>语境</label>
              <button
                type="button"
                className={`queue-lock-button${mContextLocked ? ' is-active' : ''}`}
                onClick={() => setMContextLocked((locked) => !locked)}
                aria-label={mContextLocked ? '取消锁定语境' : '锁定语境'}
                aria-pressed={mContextLocked}
                title={mContextLocked ? '取消锁定语境' : '锁定语境'}
              >
                <UiIcon name={mContextLocked ? 'lock' : 'unlock'} size={13} />
              </button>
            </div>
            <textarea className="queue-field-input queue-field-textarea" required={!mIntentionalBlank} value={mContext} onChange={e => setMContext(e.target.value)} style={{ padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', height: '72px', resize: 'vertical', background: 'rgba(255, 255, 255, 0.92)' }} placeholder={mIntentionalBlank ? '可留空' : '完整句子'} />
          </div>
          <div className="queue-field" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div className="queue-field-head">
              <label style={{ fontSize: '13px', fontWeight: '500' }}>来源</label>
              <button
                type="button"
                className={`queue-lock-button${mSourceLocked ? ' is-active' : ''}`}
                onClick={() => setMSourceLocked((locked) => !locked)}
                aria-label={mSourceLocked ? '取消锁定来源' : '锁定来源'}
                aria-pressed={mSourceLocked}
                title={mSourceLocked ? '取消锁定来源' : '锁定来源'}
              >
                <UiIcon name={mSourceLocked ? 'lock' : 'unlock'} size={13} />
              </button>
            </div>
            <input className="queue-field-input" value={mSource} onChange={e => setMSource(e.target.value)} style={{ padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.92)' }} placeholder="可选" />
          </div>
          <label className="queue-check-option">
            <input
              type="checkbox"
              checked={mIntentionalBlank}
              onChange={(e) => setMIntentionalBlank(e.target.checked)}
            />
            <span>这句话被刻意留白</span>
          </label>
          <button type="submit" className="master-primary-button queue-submit-button" style={{ marginTop: 'auto' }}>加入队列</button>
        </form>
      )}
    </div>
  ) : null;

  if (embedded) {
    return (
      <div className={`vocab-queue vocab-queue-embedded${isOpen ? ' is-open' : ''}`} aria-hidden={!isOpen}>
        {isOpen ? (
          <>
            <button type="button" className="queue-embedded-backdrop" aria-label="关闭词库工具" onClick={() => setQueueOpen(false)} />
            <div className="queue-embedded-content">
              {panelNode}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="vocab-queue" style={{ position: 'fixed', left: `${position.left}px`, bottom: `${position.bottom}px`, zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      {panelNode}

      <button 
        className="queue-fab"
        onMouseDown={handleMouseDown}
        onClick={handleButtonClick}
        title="按住即可拖动面板位置"
        style={{ padding: '12px 20px', background: '#111111', color: '#fff', border: 'none', borderRadius: '6px', boxShadow: 'none', cursor: isDragging ? 'grabbing' : 'grab', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '600', userSelect: 'none' }}
      >
        <UiIcon name="book" size={16} />
        <span>词库队列 {pendingCount > 0 && <span className="queue-fab-count" style={{ padding: '2px 6px', borderRadius: '4px', fontSize: '11px', marginLeft: '4px' }}>{pendingCount}</span>}</span>
      </button>

    </div>
  );
}
