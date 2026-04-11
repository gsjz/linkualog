import React, { useState, useEffect, useRef } from 'react';
import { addVocabulary, getVocabularyCategories } from '../api/client';

export default function VocabQueueWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('queue'); 
  const [filter, setFilter] = useState('all'); 
  const [tasks, setTasks] = useState([]);

  const [mWord, setMWord] = useState('');
  const [mContext, setMContext] = useState('');
  const [mSource, setMSource] = useState('');
  const [mFetchLlm, setMFetchLlm] = useState(false); 

  const [categories, setCategories] = useState([]);
  
  const [selectedCategory, setSelectedCategory] = useState(localStorage.getItem('defaultCategory') || '');

  const [position, setPosition] = useState({ left: 24, bottom: 24 });
  const [isDragging, setIsDragging] = useState(false);
  const offset = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  const categoryRef = useRef(selectedCategory);
  useEffect(() => {
    categoryRef.current = selectedCategory;
  }, [selectedCategory]);

  useEffect(() => {
    getVocabularyCategories().then(data => {
      if(data.categories) setCategories(data.categories);
    }).catch(err => console.error("无法加载生词本目录:", err));

    const handleConfigUpdate = () => {
      setSelectedCategory(localStorage.getItem('defaultCategory') || '');
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
    setIsOpen(!isOpen);
  };

  useEffect(() => {
  const handleEvent = (e) => {
      const { word, context, source, fetchLlm, focusPositions } = e.detail;
      const newTask = {
        id: Date.now() + Math.random().toString(36).substring(2, 9),
        word, context, source, fetchLlm,
        focusPositions: Array.isArray(focusPositions) ? focusPositions : [],
        category: categoryRef.current, 
        status: 'pending',
        error: null
      };
      setTasks(prev => [newTask, ...prev]);
    };
    window.addEventListener('add-vocab-task', handleEvent);
    return () => window.removeEventListener('add-vocab-task', handleEvent);
  }, []);

  useEffect(() => {
    const pendingTask = tasks.find(t => t.status === 'pending');
    if (pendingTask) {
      setTasks(prev => prev.map(t => t.id === pendingTask.id ? { ...t, status: 'processing' } : t));
      
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
          setTasks(prev => prev.map(t => t.id === pendingTask.id ? { ...t, status: 'success' } : t));
        })
        .catch(err => {
          setTasks(prev => prev.map(t => t.id === pendingTask.id ? { ...t, status: 'failed', error: err.message } : t));
        });
    }
  }, [tasks]); 

  const handleManualAdd = (e) => {
    e.preventDefault();
    if (!mWord) return;
    const newTask = {
      id: Date.now() + Math.random().toString(36).substring(2, 9),
      word: mWord, context: mContext, source: mSource, fetchLlm: mFetchLlm,
      focusPositions: [],
      category: selectedCategory, 
      status: 'pending', error: null
    };
    setTasks(prev => [newTask, ...prev]);
    setMWord(''); setMContext(''); 
    setActiveTab('queue');
  };

  const handleRetry = (id) => setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'pending', error: null } : t));

  const handleRequireLlm = (task) => {
    const newTask = {
      ...task,
      id: Date.now() + Math.random().toString(36).substring(2, 9),
      fetchLlm: true, status: 'pending', error: null
    };
    setTasks(prev => [newTask, ...prev]);
  };

  const filteredTasks = tasks.filter(t => filter === 'all' || t.status === filter);
  const pendingCount = tasks.filter(t => t.status === 'pending' || t.status === 'processing').length;

  return (
    <div style={{ position: 'fixed', left: `${position.left}px`, bottom: `${position.bottom}px`, zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      {isOpen && (
        <div style={{ width: '360px', height: '540px', background: '#fff', borderRadius: '8px', boxShadow: '0 10px 25px rgba(0,0,0,0.15)', border: '1px solid #e4e4e7', display: 'flex', flexDirection: 'column', marginBottom: '12px', overflow: 'hidden' }}>
          
          <div style={{ padding: '12px', borderBottom: '1px solid #e4e4e7', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '8px' }}>
             <label style={{ fontSize: '13px', fontWeight: '600', color: '#09090b', whiteSpace: 'nowrap' }}>目标分类:</label>
             <input 
               list="vocab-categories" 
               value={selectedCategory} 
               onChange={e => setSelectedCategory(e.target.value)} 
               placeholder="根目录 (默认)"
               style={{ flex: 1, padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '13px', outline: 'none' }}
             />
             <datalist id="vocab-categories">
               {categories.map(c => <option key={c} value={c} />)}
             </datalist>
          </div>

          <div style={{ display: 'flex', borderBottom: '1px solid #e4e4e7', background: '#fafafa' }}>
            <button onClick={() => setActiveTab('queue')} style={{ flex: 1, padding: '12px', border: 'none', background: activeTab === 'queue' ? '#fff' : 'transparent', fontWeight: activeTab === 'queue' ? '600' : '400', cursor: 'pointer', borderBottom: activeTab === 'queue' ? '2px solid #18181b' : '2px solid transparent' }}>任务队列 ({tasks.length})</button>
            <button onClick={() => setActiveTab('manual')} style={{ flex: 1, padding: '12px', border: 'none', background: activeTab === 'manual' ? '#fff' : 'transparent', fontWeight: activeTab === 'manual' ? '600' : '400', cursor: 'pointer', borderBottom: activeTab === 'manual' ? '2px solid #18181b' : '2px solid transparent' }}>手动录入</button>
          </div>

          {activeTab === 'queue' && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              <div style={{ padding: '8px 16px', borderBottom: '1px solid #e4e4e7', display: 'flex', gap: '8px', fontSize: '12px' }}>
                {['all', 'processing', 'success', 'failed'].map(f => (
                  <span key={f} onClick={() => setFilter(f)} style={{ cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', background: filter === f ? '#e4e4e7' : 'transparent', color: filter === f ? '#09090b' : '#71717a' }}>
                    {f === 'all' ? '全部' : f === 'processing' ? '处理中' : f === 'success' ? '成功' : '失败'}
                  </span>
                ))}
              </div>
              
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {filteredTasks.length === 0 && <div style={{ textAlign: 'center', color: '#a1a1aa', marginTop: '40px', fontSize: '13px' }}>暂无任务</div>}
                {filteredTasks.map(t => (
                  <div key={t.id} style={{ padding: '12px', border: '1px solid #e4e4e7', borderRadius: '6px', fontSize: '13px', background: t.status === 'failed' ? '#fee2e2' : '#fafafa' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <strong style={{ fontSize: '14px' }}>{t.word}</strong>
                      <span style={{ fontSize: '12px', color: t.status === 'processing' ? '#3b82f6' : t.status === 'success' ? '#10b981' : t.status === 'failed' ? '#ef4444' : '#71717a' }}>
                        {t.status === 'pending' && '等待中'}
                        {t.status === 'processing' && '处理中...'}
                        {t.status === 'success' && '成功'}
                        {t.status === 'failed' && '失败'}
                      </span>
                    </div>
                    <div style={{ color: '#71717a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '8px' }}>{t.context}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', background: '#e4e4e7', padding: '2px 6px', borderRadius: '4px' }}>{t.fetchLlm ? '解析' : '仅保存'}</span>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        {t.status === 'failed' && <button onClick={() => handleRetry(t.id)} style={{ padding: '2px 8px', fontSize: '12px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>重试</button>}
                        {(t.status === 'success' && !t.fetchLlm) && <button onClick={() => handleRequireLlm(t)} style={{ padding: '2px 8px', fontSize: '12px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>请求释义</button>}
                      </div>
                    </div>
                    {t.error && <div style={{ color: '#ef4444', fontSize: '11px', marginTop: '4px' }}>{t.error}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'manual' && (
            <form onSubmit={handleManualAdd} style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '13px', fontWeight: '500' }}>Word (Text)</label>
                <input required value={mWord} onChange={e => setMWord(e.target.value)} style={{ padding: '8px', border: '1px solid #e4e4e7', borderRadius: '4px' }} placeholder="如: abandon" />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '13px', fontWeight: '500' }}>Context</label>
                <textarea required value={mContext} onChange={e => setMContext(e.target.value)} style={{ padding: '8px', border: '1px solid #e4e4e7', borderRadius: '4px', height: '80px', resize: 'vertical' }} placeholder="所在的完整句子..." />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '13px', fontWeight: '500' }}>Source (可选)</label>
                <input value={mSource} onChange={e => setMSource(e.target.value)} style={{ padding: '8px', border: '1px solid #e4e4e7', borderRadius: '4px' }} placeholder="来源标注..." />
              </div>
              <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input type="checkbox" checked={mFetchLlm} onChange={e => setMFetchLlm(e.target.checked)} />立即请求 LLM 生成释义和发音
              </label>
              <button type="submit" style={{ padding: '10px', background: '#18181b', color: '#fff', border: 'none', borderRadius: '4px', fontWeight: '500', marginTop: 'auto', cursor: 'pointer' }}>添加到处理队列</button>
            </form>
          )}
        </div>
      )}

      <button 
        onMouseDown={handleMouseDown}
        onClick={handleButtonClick}
        title="按住即可拖动面板位置"
        style={{ padding: '12px 20px', background: '#18181b', color: '#fff', border: 'none', borderRadius: '30px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', cursor: isDragging ? 'grabbing' : 'grab', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '500', userSelect: 'none' }}
      >
        <span>词库队列 {pendingCount > 0 && <span style={{ background: '#ef4444', padding: '2px 6px', borderRadius: '10px', fontSize: '11px', marginLeft: '4px' }}>{pendingCount}</span>}</span>
      </button>

    </div>
  );
}
