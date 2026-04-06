import React, { useState } from 'react';
import { ConfigService } from '../services/configService';
import { IVideoAdapter } from '../adapters/BaseAdapter';
import { DEFAULTS } from '../constants/defaults';
import './Settings.css';

// 接收 adapter 以识别当前所处的网站环境
interface SettingsProps { adapter: IVideoAdapter; onClose: () => void; }

type CfgKey = keyof typeof DEFAULTS;

const Settings: React.FC<SettingsProps> = ({ adapter, onClose }) => {
  const [activeTab, setActiveTab] = useState<'api' | 'ui' | 'lan'>('api');

  const getAdpCfg = (key: CfgKey) => {
    const val = ConfigService.get(`${key}_${adapter.platformName}` as any);
    return (val !== null && val !== undefined && val !== '') ? val : ConfigService.get(key);
  };

  const [cfg, setCfg] = useState({
    color: ConfigService.get('theme_color') as string,
    doneColor: ConfigService.get('done_color') as string,
    errorColor: ConfigService.get('error_color') as string,
    url: ConfigService.get('api_url') as string,
    key: ConfigService.get('api_key') as string,
    model: ConfigService.get('api_model') as string,
    prompt: ConfigService.get('api_prompt') as string,
    timeout: ConfigService.get('api_timeout') as string,
    ctxSize: ConfigService.get('api_ctxSize') as string,
    lanUrl: ConfigService.get('lan_sync_url') as string,
    lanAction: ConfigService.get('lan_action') as string,
    
    layout: getAdpCfg('layout_position') as string,
    sidebarWidth: getAdpCfg('sidebar_width') as string,
    sidebarHeight: getAdpCfg('sidebar_height') as string,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setCfg(prev => ({ ...prev, [name]: value }));
  };

  const handleSave = () => {
    ConfigService.set('theme_color', cfg.color);
    ConfigService.set('done_color', cfg.doneColor);
    ConfigService.set('error_color', cfg.errorColor);
    ConfigService.set('api_url', cfg.url);
    ConfigService.set('api_key', cfg.key);
    ConfigService.set('api_model', cfg.model);
    ConfigService.set('api_prompt', cfg.prompt);
    ConfigService.set('api_timeout', cfg.timeout);
    ConfigService.set('api_ctxSize', cfg.ctxSize);
    ConfigService.set('lan_sync_url', cfg.lanUrl); 
    ConfigService.set('lan_action', cfg.lanAction);
    
    ConfigService.set(`layout_position_${adapter.platformName}` as any, cfg.layout);
    ConfigService.set(`sidebar_width_${adapter.platformName}` as any, cfg.sidebarWidth);
    ConfigService.set(`sidebar_height_${adapter.platformName}` as any, cfg.sidebarHeight);
    
    ConfigService.set('layout_position', cfg.layout);
    ConfigService.set('sidebar_width', cfg.sidebarWidth);
    ConfigService.set('sidebar_height', cfg.sidebarHeight);
    
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
              
              <div className="setting-col" style={{ marginTop: '15px' }}>
                <span style={{ fontSize: '12px', color: '#1976d2', padding: '4px 8px', background: '#e3f2fd', borderRadius: '4px' }}>
                  当前网页 ({adapter.platformName}) 的布局设置：
                </span>
              </div>

              <div className="setting-col">
                <label>UI 布局位置</label>
                <select name="layout" value={cfg.layout} onChange={handleChange} style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}>
                  <option value="right">靠右对齐 (左右分屏)</option>
                  <option value="bottom">靠下对齐 (上下分屏)</option>
                </select>
              </div>

              <div className="setting-col" style={{ opacity: cfg.layout === 'right' ? 1 : 0.5 }}>
                <label>侧边栏宽度 (px) - 仅靠右对齐时生效</label>
                <input type="number" name="sidebarWidth" value={cfg.sidebarWidth} onChange={handleChange} min="250" max="1000" disabled={cfg.layout !== 'right'} />
              </div>

              <div className="setting-col" style={{ opacity: cfg.layout === 'bottom' ? 1 : 0.5 }}>
                <label>底部栏高度 (px) - 仅靠下对齐时生效</label>
                <input type="number" name="sidebarHeight" value={cfg.sidebarHeight} onChange={handleChange} min="150" max="800" disabled={cfg.layout !== 'bottom'} />
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