import React, { useState } from 'react';
import TaskVisualizer from './components/TaskVisualizer';
import ConfigForm from './components/ConfigForm';
import './App.css';

function App() {
  const [showConfig, setShowConfig] = useState(false);

  return (
    <div style={{ minHeight: '100vh', background: '#ffffff', color: '#09090b', fontFamily: 'system-ui, sans-serif' }}>
      
      <header style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: '0 24px', 
        height: '60px',
        borderBottom: '1px solid #e4e4e7',
      }}>
        <h1 style={{ margin: 0, fontSize: '16px', fontWeight: '600' }}>数据解析控制台</h1>
        <button 
          onClick={() => setShowConfig(!showConfig)}
          style={{ 
            padding: '6px 12px', 
            cursor: 'pointer', 
            background: showConfig ? '#f4f4f5' : '#18181b', 
            color: showConfig ? '#18181b' : '#fafafa', 
            border: '1px solid #e4e4e7', 
            borderRadius: '4px',
            fontSize: '13px',
            fontWeight: '500',
          }}
        >
          {showConfig ? '收起配置' : 'API 配置'}
        </button>
      </header>

      <main style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 60px)' }}>
        {showConfig && (
          <div style={{ borderBottom: '1px solid #e4e4e7', background: '#fafafa' }}>
            <ConfigForm />
          </div>
        )}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <TaskVisualizer />
        </div>
      </main>

    </div>
  );
}

export default App;