import React, { useState } from 'react';
import TaskVisualizer from './components/TaskVisualizer';
import ConfigForm from './components/ConfigForm';
import VocabularyReview from './components/VocabularyReview'; 
import VocabQueueWidget from './components/VocabQueueWidget'; 
import './App.css';

function App() {
  const [showConfig, setShowConfig] = useState(false);
  const [currentTab, setCurrentTab] = useState('tasks');

  return (
    <div style={{ minHeight: '100vh', background: '#ffffff', color: '#09090b', fontFamily: 'system-ui, sans-serif' }}>
      
      <VocabQueueWidget />

      <header style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: '0 24px', 
        height: '60px',
        borderBottom: '1px solid #e4e4e7',
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

        <button 
          onClick={() => setShowConfig(!showConfig)}
          style={{ 
            padding: '6px 12px', cursor: 'pointer', 
            background: showConfig ? '#f4f4f5' : '#18181b', 
            color: showConfig ? '#18181b' : '#fafafa', 
            border: '1px solid #e4e4e7', borderRadius: '4px',
            fontSize: '13px', fontWeight: '500',
          }}
        >
          {showConfig ? '收起配置' : 'API 配置'}
        </button>
      </header>

      <main className="app-main" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 60px)' }}>
        {showConfig && (
          <div style={{ borderBottom: '1px solid #e4e4e7', background: '#fafafa' }}>
            <ConfigForm />
          </div>
        )}
        <div className="task-container-wrapper" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          {currentTab === 'tasks' ? <TaskVisualizer /> : <VocabularyReview />}
        </div>
      </main>

    </div>
  );
}

export default App;