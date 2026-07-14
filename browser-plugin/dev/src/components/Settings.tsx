import React, { useState } from 'react';
import { ConfigService } from '../services/configService';
import { IVideoAdapter } from '../adapters/BaseAdapter';
import { DEFAULTS } from '../constants/defaults';
import './Settings.css';

// 接收 adapter 以识别当前所处的网站环境
interface SettingsProps { adapter: IVideoAdapter; onClose: () => void; }

type CfgKey = keyof typeof DEFAULTS;

const API_BASE_PATH = '/v1';
const API_CHAT_COMPLETIONS_PATH = '/chat/completions';
const LAN_SYNC_API_PATH = '/api/vocabulary/add';
type UrlProtocol = 'http' | 'https';
type ApiEndpointPath = typeof API_BASE_PATH | typeof API_CHAT_COMPLETIONS_PATH;

const normalizeUrlPrefix = (prefix: string) => prefix.trim().replace(/\/+$/, '');

const stripUrlProtocol = (value: string) => value.replace(/^https?:\/\//i, '');

const getUrlProtocol = (url: string, fallback: UrlProtocol = 'http'): UrlProtocol => {
  const match = url.trim().match(/^(https?):\/\//i);
  if (!match) return fallback;
  return match[1].toLowerCase() === 'https' ? 'https' : 'http';
};

const buildUrlWithPath = (prefix: string, protocol: UrlProtocol, path: string) => {
  const normalizedPrefix = normalizeUrlPrefix(stripUrlProtocol(prefix));
  return normalizedPrefix ? `${protocol}://${normalizedPrefix}${path}` : '';
};

const getUrlPrefixForPath = (url: string, path: string) => {
  const trimmedUrl = normalizeUrlPrefix(url);
  const protocolMatch = trimmedUrl.match(/^https?:\/\//i);
  return protocolMatch && trimmedUrl.toLowerCase().endsWith(path.toLowerCase())
    ? normalizeUrlPrefix(trimmedUrl.slice(protocolMatch[0].length, -path.length))
    : '';
};

const getApiEndpointPath = (url: string): ApiEndpointPath => {
  const normalizedUrl = normalizeUrlPrefix(url);
  if (/\/chat\/completions$/i.test(normalizedUrl)) return API_CHAT_COMPLETIONS_PATH;
  if (/\/v1$/i.test(normalizedUrl)) return API_BASE_PATH;
  return API_BASE_PATH;
};

const getApiPrefix = (url: string) => {
  const normalizedUrl = normalizeUrlPrefix(url);
  const protocolMatch = normalizedUrl.match(/^https?:\/\//i);
  if (!protocolMatch) return '';

  const withoutProtocol = normalizedUrl.slice(protocolMatch[0].length);
  if (/\/chat\/completions$/i.test(withoutProtocol)) {
    return normalizeUrlPrefix(withoutProtocol.replace(/\/chat\/completions$/i, ''));
  }
  if (/\/v1$/i.test(withoutProtocol)) {
    return normalizeUrlPrefix(withoutProtocol.replace(/\/v1$/i, ''));
  }
  return '';
};

const buildApiUrl = (prefix: string, protocol: UrlProtocol, endpointPath: ApiEndpointPath) => {
  let normalizedPrefix = normalizeUrlPrefix(stripUrlProtocol(prefix))
    .replace(/\/chat\/completions$/i, '');

  if (endpointPath === API_BASE_PATH) {
    normalizedPrefix = normalizedPrefix.replace(/\/v1$/i, '');
  }

  return buildUrlWithPath(normalizedPrefix, protocol, endpointPath);
};

const buildLanSyncUrl = (prefix: string, protocol: UrlProtocol) => (
  buildUrlWithPath(stripUrlProtocol(prefix).replace(/\/api\/vocabulary\/add$/i, ''), protocol, LAN_SYNC_API_PATH)
);

const getLanPrefix = (url: string) => getUrlPrefixForPath(url, LAN_SYNC_API_PATH);

const Settings: React.FC<SettingsProps> = ({ adapter, onClose }) => {
  const [activeTab, setActiveTab] = useState<'api' | 'params' | 'ui'>('api');

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
    webTargetLanguage: ConfigService.get('web_target_language') as string,
    webTranslationPrompt: ConfigService.get('web_translation_prompt') as string,
    timeout: ConfigService.get('api_timeout') as string,
    ctxSize: ConfigService.get('api_ctxSize') as string,
    lanUrl: ConfigService.get('lan_sync_url') as string,
    lanAction: ConfigService.get('lan_action') as string,
    mobileFullscreenMode: ConfigService.get('mobile_fullscreen_mode') as string,
    
    layout: getAdpCfg('layout_position') as string,
    sidebarWidth: getAdpCfg('sidebar_width') as string,
    sidebarHeight: getAdpCfg('sidebar_height') as string,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setCfg(prev => ({ ...prev, [name]: value }));
  };

  const handleApiPrefixChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCfg(prev => ({ ...prev, url: buildApiUrl(e.target.value, getUrlProtocol(prev.url, 'https'), getApiEndpointPath(prev.url)) }));
  };

  const handleApiProtocolChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const protocol = e.target.value as UrlProtocol;
    setCfg(prev => {
      const prefix = getApiPrefix(prev.url);
      return prefix ? { ...prev, url: buildApiUrl(prefix, protocol, getApiEndpointPath(prev.url)) } : prev;
    });
  };

  const handleApiEndpointPathChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const endpointPath = e.target.value as ApiEndpointPath;
    setCfg(prev => {
      const prefix = getApiPrefix(prev.url);
      return prefix ? { ...prev, url: buildApiUrl(prefix, getUrlProtocol(prev.url, 'https'), endpointPath) } : prev;
    });
  };

  const handleLanPrefixChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCfg(prev => ({ ...prev, lanUrl: buildLanSyncUrl(e.target.value, getUrlProtocol(prev.lanUrl)) }));
  };

  const handleLanProtocolChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const protocol = e.target.value as UrlProtocol;
    setCfg(prev => {
      const prefix = getLanPrefix(prev.lanUrl);
      return prefix ? { ...prev, lanUrl: buildLanSyncUrl(prefix, protocol) } : prev;
    });
  };

  const handleSave = () => {
    ConfigService.set('theme_color', cfg.color);
    ConfigService.set('done_color', cfg.doneColor);
    ConfigService.set('error_color', cfg.errorColor);
    ConfigService.set('api_url', cfg.url);
    ConfigService.set('api_key', cfg.key);
    ConfigService.set('api_model', cfg.model);
    ConfigService.set('api_prompt', cfg.prompt);
    ConfigService.set('web_target_language', cfg.webTargetLanguage);
    ConfigService.set('web_translation_prompt', cfg.webTranslationPrompt);
    ConfigService.set('api_timeout', cfg.timeout);
    ConfigService.set('api_ctxSize', cfg.ctxSize);
    ConfigService.set('lan_sync_url', cfg.lanUrl.trim());
    ConfigService.set('lan_action', cfg.lanAction);
    ConfigService.set('mobile_fullscreen_mode', cfg.mobileFullscreenMode);
    
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

  const apiPrefix = getApiPrefix(cfg.url);
  const apiProtocol = getUrlProtocol(cfg.url, 'https');
  const apiEndpointPath = getApiEndpointPath(cfg.url);
  const lanPrefix = getLanPrefix(cfg.lanUrl);
  const lanProtocol = getUrlProtocol(cfg.lanUrl);

  return (
    <div className="modal" onMouseDown={handleBackdropMouseDown}>
      <div className="modal-box">
        <div className="modal-header">
          <h3>全局设置</h3>
          <span className="close-btn" onClick={onClose} title="关闭">&times;</span>
        </div>

        <div className="tabs">
          <div className={`tab ${activeTab === 'api' ? 'active' : ''}`} onClick={() => setActiveTab('api')}>🔌 API 设置</div>
          <div className={`tab ${activeTab === 'params' ? 'active' : ''}`} onClick={() => setActiveTab('params')}>⚙️ 参数调整</div>
          <div className={`tab ${activeTab === 'ui' ? 'active' : ''}`} onClick={() => setActiveTab('ui')}>🎨 界面设置</div>
        </div>

        <div className="tab-content">
          {activeTab === 'api' && (
            <div className="tab-pane fade-in">
              <div className="setting-col">
                <label>API URL（快捷）</label>
                <div className="url-prefix-row">
                  <select className="url-protocol-select" value={apiProtocol} onChange={handleApiProtocolChange} aria-label="API 协议">
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                  <input value={apiPrefix} onChange={handleApiPrefixChange} placeholder="dashscope.aliyuncs.com/compatible-mode/v1" />
                  <select className="url-path-select" value={apiEndpointPath} onChange={handleApiEndpointPathChange} aria-label="API 端点">
                    <option value={API_BASE_PATH}>/v1</option>
                    <option value={API_CHAT_COMPLETIONS_PATH}>/chat/completions</option>
                  </select>
                </div>
                <div className="setting-help">快捷模式支持 /v1 或 /chat/completions；如需 /v1/chat/completions，可让前缀以 /v1 结尾。</div>
              </div>
              <div className="setting-col">
                <label>API URL（完整）</label>
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
                <label>后端服务前缀（快捷）</label>
                <div className="url-prefix-row">
                  <select className="url-protocol-select" value={lanProtocol} onChange={handleLanProtocolChange} aria-label="后端服务协议">
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                  <input value={lanPrefix} onChange={handleLanPrefixChange} placeholder="127.0.0.1:8000" />
                  <span className="url-fixed-suffix">{LAN_SYNC_API_PATH}</span>
                </div>
                <div className="setting-help">只填写主机和端口会自动生成下方完整地址；如需自定义协议或路径，可直接编辑完整 API 地址。</div>
              </div>
              <div className="setting-col">
                <label>后端生词添加 API 地址（完整）</label>
                <input name="lanUrl" value={cfg.lanUrl} onChange={handleChange} placeholder="http://127.0.0.1:8000/api/vocabulary/add" />
              </div>
              <div className="setting-col">
                <label>默认生词本目录 (Category)</label>
                <input name="lanAction" value={cfg.lanAction} onChange={handleChange} placeholder="例如: Video_Sync" />
              </div>
            </div>
          )}

          {activeTab === 'params' && (
            <div className="tab-pane fade-in">
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
              <div className="setting-col">
                <label>网页翻译目标语言</label>
                <input name="webTargetLanguage" value={cfg.webTargetLanguage} onChange={handleChange} placeholder="例如：简体中文" />
              </div>
              <div className="setting-col">
                <label>网页翻译提示词</label>
                <textarea name="webTranslationPrompt" value={cfg.webTranslationPrompt} onChange={handleChange} placeholder="留空则使用默认学术翻译提示词" />
                <div className="setting-help">网页翻译会按段请求模型；提示词应要求模型只输出译文。</div>
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
                <label>移动端全屏按钮</label>
                <select name="mobileFullscreenMode" value={cfg.mobileFullscreenMode} onChange={handleChange} style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}>
                  <option value="off">关闭</option>
                  <option value="video">只在视频页开启</option>
                  <option value="always">任意页面开启</option>
                </select>
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
