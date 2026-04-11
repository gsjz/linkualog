import React, { useState, useEffect } from 'react';
import TaskVisualizer from './components/TaskVisualizer';
import ConfigForm from './components/ConfigForm';
import VocabularyReview from './components/VocabularyReview'; 
import VocabQueueWidget from './components/VocabQueueWidget'; 
import { getVocabularyCategories } from './api/client';
import './App.css';

function App() {
  const [showConfig, setShowConfig] = useState(false);
  const [currentTab, setCurrentTab] = useState('tasks');
  const [defaultCategory, setDefaultCategory] = useState(localStorage.getItem('defaultCategory') || '');
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    getVocabularyCategories()
      .then((data) => setCategories(data.categories || []))
      .catch(() => {});

    const handleDefaultCategoryUpdate = (e) => {
      const fromEvent = e?.detail?.category;
      if (typeof fromEvent === 'string') {
        setDefaultCategory(fromEvent);
      } else {
        setDefaultCategory(localStorage.getItem('defaultCategory') || '');
      }
    };

    window.addEventListener('default-category-updated', handleDefaultCategoryUpdate);
    return () => window.removeEventListener('default-category-updated', handleDefaultCategoryUpdate);
  }, []);

  const handleDefaultCategoryChange = (nextCategory) => {
    const finalCategory = nextCategory || '';
    localStorage.setItem('defaultCategory', finalCategory);
    setDefaultCategory(finalCategory);
    window.dispatchEvent(new Event('config-updated'));
    window.dispatchEvent(new CustomEvent('default-category-updated', {
      detail: { category: finalCategory }
    }));
  };

  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: '#ffffff', color: '#09090b', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column' }}>
      
      <VocabQueueWidget />

      <header style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: '0 24px', 
        height: '60px',
        borderBottom: '1px solid #e4e4e7',
        flexShrink: 0,
        boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <h1 style={{ margin: 0, fontSize: '16px', fontWeight: '600' }}>Linkual Log</h1>
          
          <div style={{ display: 'flex', gap: '8px', background: '#f4f4f5', padding: '4px', borderRadius: '6px' }}>
            <button 
              onClick={() => setCurrentTab('tasks')}
              style={{
                padding: '4px 12px', border: 'none', borderRadius: '4px', fontSize: '13px', cursor: 'pointer',
                background: currentTab === 'tasks' ? '#fff' : 'transparent',
                boxShadow: currentTab === 'tasks' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
                color: currentTab === 'tasks' ? '#09090b' : '#71717a',
                fontWeight: currentTab === 'tasks' ? '600' : '400'
              }}
            >
              OCR 解析库
            </button>
            <button 
              onClick={() => setCurrentTab('vocabulary')}
              style={{
                padding: '4px 12px', border: 'none', borderRadius: '4px', fontSize: '13px', cursor: 'pointer',
                background: currentTab === 'vocabulary' ? '#fff' : 'transparent',
                boxShadow: currentTab === 'vocabulary' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
                color: currentTab === 'vocabulary' ? '#09090b' : '#71717a',
                fontWeight: currentTab === 'vocabulary' ? '600' : '400'
              }}
            >
              我的生词本
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#71717a' }}>
            默认生词本目录
            <select
              value={defaultCategory}
              onChange={(e) => handleDefaultCategoryChange(e.target.value)}
              style={{ padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '12px', outline: 'none', color: '#09090b', minWidth: '150px', background: '#fff' }}
            >
              <option value="">根目录 (默认)</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>

          <button 
            onClick={() => setShowConfig(true)}
            style={{ 
              padding: '6px 12px', cursor: 'pointer', 
              background: '#18181b', 
              color: '#fafafa', 
              border: '1px solid #18181b', borderRadius: '4px',
              fontSize: '13px', fontWeight: '500',
            }}
          >
            ⚙️ 全局配置
          </button>
        </div>
      </header>

      {showConfig && <ConfigForm onClose={() => setShowConfig(false)} />}

      <main className="app-main" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div className="task-container-wrapper" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          <div style={{ display: currentTab === 'tasks' ? 'flex' : 'none', flex: 1, minHeight: 0 }} aria-hidden={currentTab !== 'tasks'}>
            <TaskVisualizer />
          </div>
          <div style={{ display: currentTab === 'vocabulary' ? 'flex' : 'none', flex: 1, minHeight: 0 }} aria-hidden={currentTab !== 'vocabulary'}>
            <VocabularyReview />
          </div>
        </div>
      </main>

    </div>
  );
}

export default App;
