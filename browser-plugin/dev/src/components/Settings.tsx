import React, { useState } from 'react';
import { ConfigService } from '../services/configService';
import './Settings.css';

interface SettingsProps { onClose: () => void; }

const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const [activeTab, setActiveTab] = useState<'api' | 'ui' | 'lan'>('api');

  const [cfg, setCfg] = useState({
    color: ConfigService.get('theme_color') as string,
    doneColor: ConfigService.get('done_color') as string,
    errorColor: ConfigService.get('error_color') as string,
    sidebarWidth: ConfigService.get('sidebar_width') as string,
    url: ConfigService.get('api_url') as string,
    key: ConfigService.get('api_key') as string,
    model: ConfigService.get('api_model') as string,
    prompt: ConfigService.get('api_prompt') as string,
    timeout: ConfigService.get('api_timeout') as string,
    ctxSize: ConfigService.get('api_ctxSize') as string,
    lanUrl: ConfigService.get('lan_sync_url') as string,
    lanAction: ConfigService.get('lan_action') as string,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setCfg(prev => ({ ...prev, [name]: value }));
  };

  const handleSave = () => {
    ConfigService.set('theme_color', cfg.color);
    ConfigService.set('done_color', cfg.doneColor);
    ConfigService.set('error_color', cfg.errorColor);
    ConfigService.set('sidebar_width', cfg.sidebarWidth);
    ConfigService.set('api_url', cfg.url);
    ConfigService.set('api_key', cfg.key);
    ConfigService.set('api_model', cfg.model);
    ConfigService.set('api_prompt', cfg.prompt);
    ConfigService.set('api_timeout', cfg.timeout);
    ConfigService.set('api_ctxSize', cfg.ctxSize);
    ConfigService.set('lan_sync_url', cfg.lanUrl); 
    ConfigService.set('lan_action', cfg.lanAction);
    
    onClose();
    window.dispatchEvent(new Event('linkual_settings_updated'));
  };

  const handleReset = () => {
    if (window.confirm('清空所有自定义设置恢复默认？')) {
      ConfigService.reset();
      onClose();
      window.dispatchEvent(new Event('linkual_settings_updated'));
    }
  };

  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal" onMouseDown={handleBackdropMouseDown}>
      <div className="modal-box">
        <div className="modal-header">
          <h3>全局设置</h3>
          <span className="close-btn" onClick={onClose} title="关闭">&times;</span>
        </div>

        <div className="tabs">
          <div className={`tab ${activeTab === 'api' ? 'active' : ''}`} onClick={() => setActiveTab('api')}>🔌 API 设置</div>
          <div className={`tab ${activeTab === 'ui' ? 'active' : ''}`} onClick={() => setActiveTab('ui')}>🎨 界面设置</div>
          <div className={`tab ${activeTab === 'lan' ? 'active' : ''}`} onClick={() => setActiveTab('lan')}>📡 局域网</div>
        </div>

        <div className="tab-content">
          {activeTab === 'api' && (
            <div className="tab-pane fade-in">
              <div className="setting-col">
                <label>API URL</label>
                <input name="url" value={cfg.url} onChange={handleChange} placeholder="https://..." />
              </div>
              <div className="setting-col">
                <label>API Key</label>
                <input name="key" type="password" value={cfg.key} onChange={handleChange} placeholder="sk-..." />
              </div>
              <div className="setting-col">
                <label>对话模型 (Model)</label>
                <input name="model" value={cfg.model} onChange={handleChange} placeholder="如：gpt-3.5-turbo" />
              </div>
              <div className="setting-col">
                <label>上下文携带数量 (上下各取 N 条)</label>
                <input type="number" name="ctxSize" value={cfg.ctxSize} onChange={handleChange} min="0" max="10" />
              </div>
              <div className="setting-col">
                <label>API 超时时间 (秒)</label>
                <input type="number" name="timeout" value={cfg.timeout} onChange={handleChange} min="5" max="120" />
              </div>
              <div className="setting-col">
                <label>提示词 (Prompt)</label>
                <textarea name="prompt" value={cfg.prompt} onChange={handleChange} placeholder="请输入系统提示词..." />
              </div>
            </div>
          )}

          {activeTab === 'ui' && (
            <div className="tab-pane fade-in">
              <div className="setting-row">
                <label>主题颜色</label>
                <input type="color" name="color" value={cfg.color} onChange={handleChange} />
              </div>
              <div className="setting-row">
                <label>解析成功背景色</label>
                <input type="color" name="doneColor" value={cfg.doneColor} onChange={handleChange} />
              </div>
              <div className="setting-row">
                <label>解析失败背景色</label>
                <input type="color" name="errorColor" value={cfg.errorColor} onChange={handleChange} />
              </div>
              <div className="setting-col">
                <label>侧边栏宽度 (px)</label>
                <input type="number" name="sidebarWidth" value={cfg.sidebarWidth} onChange={handleChange} min="250" max="1000" />
              </div>
            </div>
          )}

          {activeTab === 'lan' && (
            <div className="tab-pane fade-in">
              <div className="setting-col">
                <label>后端生词添加 API 地址</label>
                <input name="lanUrl" value={cfg.lanUrl} onChange={handleChange} placeholder="http://127.0.0.1:8000/api/vocabulary/add" />
              </div>
              <div className="setting-col">
                <label>默认生词本目录 (Category)</label>
                <input name="lanAction" value={cfg.lanAction} onChange={handleChange} placeholder="例如: Video_Sync" />
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn reset-btn" onClick={handleReset}>恢复默认</button>
          <button className="btn save-btn" style={{ background: cfg.color, color: '#fff' }} onClick={handleSave}>
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
};

export default Settings;