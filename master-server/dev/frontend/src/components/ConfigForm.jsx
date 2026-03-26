import React, { useState, useEffect } from 'react';
import { fetchConfig, saveConfig, getVocabularyCategories } from '../api/client';

export default function ConfigForm({ onClose }) {
  const [config, setConfig] = useState({
    provider: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen3.5-27b',
    apiKey: '',
    hasKey: false
  });
  const [foldedKeysStr, setFoldedKeysStr] = useState('');
  const [defaultCategory, setDefaultCategory] = useState('');
  const [categories, setCategories] = useState([]);
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    const localKeys = localStorage.getItem('defaultFoldedKeys');
    setFoldedKeysStr(localKeys !== null ? localKeys : 'extracted_text');
    
    const localCat = localStorage.getItem('defaultCategory');
    setDefaultCategory(localCat !== null ? localCat : '');

    getVocabularyCategories()
      .then(data => { if(data.categories) setCategories(data.categories); })
      .catch(err => console.error("无法加载目录:", err));

    fetchConfig()
      .then(data => {
        setConfig(prev => ({ ...prev, provider: data.provider || prev.provider, model: data.model || prev.model, hasKey: data.hasKey }));
      })
      .catch(err => console.error("无法连接到后端:", err));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    localStorage.setItem('defaultFoldedKeys', foldedKeysStr);
    localStorage.setItem('defaultCategory', defaultCategory);
    window.dispatchEvent(new Event('config-updated'));

    const formData = new FormData();
    formData.append('provider', config.provider);
    formData.append('model', config.model);
    formData.append('api_key', config.apiKey);

    try {
      const data = await saveConfig(formData);
      setStatusMsg(data.message || "保存配置成功！");
      setConfig(prev => ({ ...prev, apiKey: '', hasKey: true }));
      setTimeout(() => {
        setStatusMsg('');
        onClose();
      }, 1500);
    } catch (err) {
      setStatusMsg("保存配置失败: " + err.message);
    }
  };

  const labelStyle = { display: 'flex', flexDirection: 'column', fontSize: '13px', color: '#09090b', fontWeight: '500', width: '100%' };
  const inputStyle = { 
    padding: '8px 12px', marginTop: '6px', border: '1px solid #e4e4e7', 
    borderRadius: '4px', fontSize: '13px', outline: 'none', background: '#fff'
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: 'rgba(0, 0, 0, 0.4)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        background: '#ffffff', width: '100%', maxWidth: '460px', borderRadius: '12px',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden'
      }}>
        
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #e4e4e7', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fafafa' }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: '#09090b' }}>⚙️ 全局设置</h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#71717a' }}>✕</button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <label style={labelStyle}>
              接口地址 (Provider API):
              <input type="text" value={config.provider} onChange={e => setConfig({ ...config, provider: e.target.value })} style={inputStyle} required />
            </label>
            <label style={labelStyle}>
              模型名称 (Model):
              <input type="text" value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })} style={inputStyle} required />
            </label>
            <label style={labelStyle}>
              API Key {config.hasKey && <span style={{ color: '#10b981', fontSize: '12px', fontWeight: '400', marginLeft: '4px' }}>(已缓存 ✅)</span>}
              <input type="password" value={config.apiKey} onChange={e => setConfig({ ...config, apiKey: e.target.value })} placeholder={config.hasKey ? "留空则保持原密钥" : "输入 API Key"} style={inputStyle} />
            </label>
          </div>

          <div style={{ height: '1px', background: '#e4e4e7', margin: '4px 0' }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <label style={labelStyle}>
              默认生词本保存目录:
              <input 
                list="config-vocab-categories" 
                value={defaultCategory} 
                onChange={e => setDefaultCategory(e.target.value)} 
                placeholder="留空即为根目录" 
                style={inputStyle} 
              />
              <datalist id="config-vocab-categories">
                {categories.map(c => <option key={c} value={c} />)}
              </datalist>
            </label>
            
            <label style={labelStyle}>
              默认折叠的 JSON 键名 (逗号分隔):
              <input type="text" value={foldedKeysStr} onChange={e => setFoldedKeysStr(e.target.value)} placeholder="如: extracted_text" style={inputStyle} />
            </label>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '12px', marginTop: '8px' }}>
            {statusMsg && (
              <span style={{ fontSize: '13px', color: statusMsg.includes('失败') ? '#ef4444' : '#10b981' }}>
                {statusMsg}
              </span>
            )}
            <button type="button" onClick={onClose} style={{ padding: '8px 16px', background: '#f4f4f5', color: '#09090b', border: '1px solid #e4e4e7', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontWeight: '500' }}>取消</button>
            <button type="submit" style={{ padding: '8px 24px', background: '#18181b', color: '#fff', border: '1px solid transparent', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontWeight: '500' }}>保存设置</button>
          </div>

        </form>
      </div>
    </div>
  );
}