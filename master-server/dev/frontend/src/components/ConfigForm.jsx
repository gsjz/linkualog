import React, { useState, useEffect } from 'react';
import { fetchConfig, saveConfig } from '../api/client';

export default function ConfigForm() {
  const [config, setConfig] = useState({
    provider: 'https://api.siliconflow.cn/v1/chat/completions',
    model: 'Qwen/Qwen3.5-4B',
    apiKey: '',
    hasKey: false
  });
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    fetchConfig()
      .then(data => {
        setConfig(prev => ({ ...prev, provider: data.provider || prev.provider, model: data.model || prev.model, hasKey: data.hasKey }));
      })
      .catch(err => console.error("无法连接到后端:", err));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData();
    formData.append('provider', config.provider);
    formData.append('model', config.model);
    formData.append('api_key', config.apiKey);

    try {
      const data = await saveConfig(formData);
      setStatusMsg(data.message);
      setConfig(prev => ({ ...prev, apiKey: '', hasKey: true }));
      setTimeout(() => setStatusMsg(''), 3000);
    } catch (err) {
      setStatusMsg("保存配置失败: " + err.message);
    }
  };

  const labelStyle = { display: 'flex', flexDirection: 'column', fontSize: '13px', color: '#09090b', fontWeight: '500', width: '240px' };
  const inputStyle = { 
    padding: '6px 10px', marginTop: '6px', border: '1px solid #e4e4e7', 
    borderRadius: '4px', fontSize: '13px', outline: 'none', background: '#fff'
  };

  return (
    <div style={{ padding: '24px' }}>
      <form className="config-form" onSubmit={handleSubmit} style={{ display: 'flex', gap: '24px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="config-label" style={labelStyle}>
          接口地址 (Provider API):
          <input type="text" value={config.provider} onChange={e => setConfig({ ...config, provider: e.target.value })} style={inputStyle} required />
        </label>
        
        <label className="config-label" style={labelStyle}>
          模型名称 (Model):
          <input type="text" value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })} style={inputStyle} required />
        </label>
        
        <label className="config-label" style={labelStyle}>
          API Key {config.hasKey && <span style={{ color: '#71717a', fontSize: '12px', fontWeight: '400' }}>(已缓存)</span>}
          <input type="password" value={config.apiKey} onChange={e => setConfig({ ...config, apiKey: e.target.value })} placeholder={config.hasKey ? "留空则保持原密钥" : "输入 API Key"} style={inputStyle} />
        </label>
        
        <button type="submit" style={{ padding: '7px 16px', background: '#18181b', color: '#fff', border: '1px solid transparent', borderRadius: '4px', fontSize: '13px', cursor: 'pointer', height: 'fit-content' }}>
          保存配置
        </button>

        {statusMsg && (
          <span style={{ fontSize: '13px', color: statusMsg.includes('失败') ? '#ef4444' : '#10b981', marginLeft: '8px' }}>
            {statusMsg}
          </span>
        )}
      </form>
    </div>
  );
}