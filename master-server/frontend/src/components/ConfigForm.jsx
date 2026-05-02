import React, { useEffect, useState } from 'react';

import { fetchConfig, resetConfig, saveConfig } from '../api/client';

const DEFAULT_PROVIDER = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const DEFAULT_MODEL = 'qwen3.5-flash';
const DEFAULT_UI_CONFIG = {
  defaultFoldedKeys: 'extracted_text,bbox',
  defaultCategory: '',
};
const PAGES = [
  { id: 'llm', label: '1. LLM' },
  { id: 'runtime', label: '2. 服务' },
  { id: 'review', label: '3. Review' },
  { id: 'ui', label: '4. 界面' },
];

function readLocalUiConfig() {
  return {
    defaultFoldedKeys: localStorage.getItem('defaultFoldedKeys') ?? DEFAULT_UI_CONFIG.defaultFoldedKeys,
    defaultCategory: String(localStorage.getItem('defaultCategory') ?? DEFAULT_UI_CONFIG.defaultCategory).trim(),
  };
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function inputStyle(disabled = false) {
  return {
    padding: '9px 12px',
    marginTop: '6px',
    border: '1px solid var(--ms-border)',
    borderRadius: '6px',
    fontSize: '13px',
    outline: 'none',
    background: disabled ? 'var(--ms-surface-muted)' : 'var(--ms-surface-strong)',
    color: 'var(--ms-text)',
  };
}

export default function ConfigForm({ onClose, categories = [] }) {
  const [page, setPage] = useState(PAGES[0].id);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusKind, setStatusKind] = useState('success');
  const [config, setConfig] = useState({
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    api_key: '',
    hasKey: false,
    frontend_port: 8000,
    backend_port: 8080,
    log_level: 'INFO',
    review_llm_timeout_seconds: 75,
    review_folder_merge_llm_timeout_seconds: 90,
    review_folder_merge_llm_max_tokens: 900,
    review_folder_merge_llm_max_tokens_cap: 3200,
    review_folder_merge_max_suggestions: 40,
    review_folder_merge_temperature: 0,
    review_folder_merge_word_limit: 200,
    review_llm_connectivity_check: true,
    review_llm_connectivity_timeout_seconds: 3,
    review_llm_connectivity_strict: false,
    review_llm_connectivity_probe_ttl_seconds: 180,
    review_llm_request_max_retries: 2,
    review_llm_request_retry_backoff_seconds: 1,
    review_recommend_due_weight: 2.2,
    review_recommend_created_weight: 0.35,
    review_recommend_score_weight: 0.75,
    review_recommend_created_order: 'recent',
    review_recommend_score_order: 'low',
    running_in_docker: false,
  });
  const [uiConfig, setUiConfig] = useState(readLocalUiConfig);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    fetchConfig()
      .then((data) => {
        if (cancelled) return;
        setConfig((prev) => ({
          ...prev,
          ...data,
          provider: data.provider || prev.provider,
          model: data.model || prev.model,
          hasKey: Boolean(data.hasKey),
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setStatusKind('error');
        setStatusMsg(`读取配置失败: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !saving && !resetting) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, saving, resetting]);

  const setField = (key, value) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setStatusMsg('');

    const payload = {
      provider: config.provider,
      model: config.model,
      api_key: config.api_key,
      frontend_port: numberValue(config.frontend_port, 8000),
      backend_port: numberValue(config.backend_port, 8080),
      log_level: String(config.log_level || 'INFO').trim().toUpperCase(),
      review_llm_timeout_seconds: numberValue(config.review_llm_timeout_seconds, 75),
      review_folder_merge_llm_timeout_seconds: numberValue(config.review_folder_merge_llm_timeout_seconds, 90),
      review_folder_merge_llm_max_tokens: numberValue(config.review_folder_merge_llm_max_tokens, 900),
      review_folder_merge_llm_max_tokens_cap: numberValue(config.review_folder_merge_llm_max_tokens_cap, 3200),
      review_folder_merge_max_suggestions: numberValue(config.review_folder_merge_max_suggestions, 40),
      review_folder_merge_temperature: numberValue(config.review_folder_merge_temperature, 0),
      review_folder_merge_word_limit: numberValue(config.review_folder_merge_word_limit, 200),
      review_llm_connectivity_check: Boolean(config.review_llm_connectivity_check),
      review_llm_connectivity_timeout_seconds: numberValue(config.review_llm_connectivity_timeout_seconds, 3),
      review_llm_connectivity_strict: Boolean(config.review_llm_connectivity_strict),
      review_llm_connectivity_probe_ttl_seconds: numberValue(config.review_llm_connectivity_probe_ttl_seconds, 180),
      review_llm_request_max_retries: numberValue(config.review_llm_request_max_retries, 2),
      review_llm_request_retry_backoff_seconds: numberValue(config.review_llm_request_retry_backoff_seconds, 1),
      review_recommend_due_weight: numberValue(config.review_recommend_due_weight, 2.2),
      review_recommend_created_weight: numberValue(config.review_recommend_created_weight, 0.35),
      review_recommend_score_weight: numberValue(config.review_recommend_score_weight, 0.75),
      review_recommend_created_order: config.review_recommend_created_order === 'oldest' ? 'oldest' : 'recent',
      review_recommend_score_order: config.review_recommend_score_order === 'high' ? 'high' : 'low',
    };

    try {
      const data = await saveConfig(payload);
      const defaultCategory = String(uiConfig.defaultCategory || '').trim();

      localStorage.setItem('defaultFoldedKeys', uiConfig.defaultFoldedKeys);
      localStorage.setItem('defaultCategory', defaultCategory);
      window.dispatchEvent(new Event('config-updated'));
      window.dispatchEvent(new CustomEvent('default-category-updated', {
        detail: { category: defaultCategory },
      }));

      setConfig((prev) => ({
        ...prev,
        ...(data.data || {}),
        api_key: '',
        hasKey: Boolean(data?.data?.hasKey ?? true),
      }));
      setStatusKind('success');
      setStatusMsg('设置已保存。端口类配置需要重启服务后生效。');
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err) {
      setStatusKind('error');
      setStatusMsg(`保存配置失败: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = async () => {
    setResetting(true);
    setStatusMsg('');

    try {
      const data = await resetConfig();
      const nextUiConfig = { ...DEFAULT_UI_CONFIG };

      localStorage.setItem('defaultFoldedKeys', nextUiConfig.defaultFoldedKeys);
      localStorage.setItem('defaultCategory', nextUiConfig.defaultCategory);
      localStorage.removeItem('vocabReviewCategory');
      setUiConfig(nextUiConfig);

      setConfig((prev) => ({
        ...prev,
        ...(data.data || {}),
        api_key: '',
        hasKey: Boolean(data?.data?.hasKey),
      }));

      window.dispatchEvent(new CustomEvent('config-updated', {
        detail: { category: nextUiConfig.defaultCategory },
      }));
      window.dispatchEvent(new CustomEvent('default-category-updated', {
        detail: { category: nextUiConfig.defaultCategory },
      }));

      setStatusKind('success');
      setStatusMsg('已同步为默认设置。端口类配置需要重启服务后生效。');
    } catch (err) {
      setStatusKind('error');
      setStatusMsg(`同步默认设置失败: ${err.message}`);
    } finally {
      setResetting(false);
    }
  };

  const labelStyle = { display: 'flex', flexDirection: 'column', fontSize: '13px', color: 'var(--ms-text)', fontWeight: '600', width: '100%' };
  const rowStyle = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' };

  return (
    <div className="config-modal">
      <div className="config-modal-card">
        <div className="config-modal-header">
          <div>
            <h2 className="config-modal-title">全局设置</h2>
            <div className="config-modal-subtitle">
              所有设置都可写入本地配置文件；端口类配置重启后生效。
            </div>
          </div>
          <button type="button" className="config-modal-close" onClick={onClose} disabled={saving || resetting}>✕</button>
        </div>

        <div className="config-modal-tabs">
          {PAGES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setPage(item.id)}
              className={`config-modal-tab${page === item.id ? ' is-active' : ''}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="config-modal-form">
          <div className="config-modal-body">
            {page === 'llm' ? (
              <>
                <div className="config-info-box">
                  OCR 下划线词坐标已默认开启，不再提供实验开关。
                </div>
                <label style={labelStyle}>
                  接口地址 (Provider API)
                  <input type="text" value={config.provider} onChange={(e) => setField('provider', e.target.value)} style={inputStyle(loading)} required disabled={loading || saving || resetting} />
                </label>
                <label style={labelStyle}>
                  模型名称 (Model)
                  <input type="text" value={config.model} onChange={(e) => setField('model', e.target.value)} style={inputStyle(loading)} required disabled={loading || saving || resetting} />
                </label>
                <label style={labelStyle}>
                  API Key {config.hasKey ? <span style={{ color: 'var(--ms-text-muted)', fontSize: '12px', fontWeight: 500, marginLeft: '6px' }}>(已保存)</span> : null}
                  <input
                    type="password"
                    value={config.api_key}
                    onChange={(e) => setField('api_key', e.target.value)}
                    placeholder={config.hasKey ? '留空则保持原密钥' : '输入新的 API Key'}
                    style={inputStyle(loading)}
                    disabled={loading || saving || resetting}
                  />
                </label>
              </>
            ) : null}

            {page === 'runtime' ? (
              <>
                <div className="config-info-box">
                  当前运行环境：{config.running_in_docker ? 'Docker' : '非 Docker'}。默认前端端口会在非 Docker 时回落到 `8000`，Docker 内回落到 `80`。
                </div>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    前端端口
                    <input type="number" value={config.frontend_port} onChange={(e) => setField('frontend_port', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                  <label style={labelStyle}>
                    后端端口
                    <input type="number" value={config.backend_port} onChange={(e) => setField('backend_port', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                </div>
                <label style={labelStyle}>
                  日志级别
                  <select value={config.log_level} onChange={(e) => setField('log_level', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting}>
                    <option value="DEBUG">DEBUG</option>
                    <option value="INFO">INFO</option>
                    <option value="WARNING">WARNING</option>
                    <option value="ERROR">ERROR</option>
                  </select>
                </label>
              </>
            ) : null}

            {page === 'review' ? (
              <>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    Review LLM 超时（秒）
                    <input type="number" step="0.1" value={config.review_llm_timeout_seconds} onChange={(e) => setField('review_llm_timeout_seconds', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                  <label style={labelStyle}>
                    目录合并超时（秒）
                    <input type="number" step="0.1" value={config.review_folder_merge_llm_timeout_seconds} onChange={(e) => setField('review_folder_merge_llm_timeout_seconds', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                </div>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    目录合并输出 Token
                    <input type="number" value={config.review_folder_merge_llm_max_tokens} onChange={(e) => setField('review_folder_merge_llm_max_tokens', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                  <label style={labelStyle}>
                    目录合并 Token 上限
                    <input type="number" value={config.review_folder_merge_llm_max_tokens_cap} onChange={(e) => setField('review_folder_merge_llm_max_tokens_cap', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                </div>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    最多建议数
                    <input type="number" value={config.review_folder_merge_max_suggestions} onChange={(e) => setField('review_folder_merge_max_suggestions', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                  <label style={labelStyle}>
                    目录裁剪词数
                    <input type="number" value={config.review_folder_merge_word_limit} onChange={(e) => setField('review_folder_merge_word_limit', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                </div>
                <label style={labelStyle}>
                  目录合并温度
                  <input type="number" step="0.1" value={config.review_folder_merge_temperature} onChange={(e) => setField('review_folder_merge_temperature', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                </label>
                <div style={{ height: '1px', background: 'var(--ms-border)' }} />
                <label className="config-inline-check">
                  <input type="checkbox" checked={Boolean(config.review_llm_connectivity_check)} onChange={(e) => setField('review_llm_connectivity_check', e.target.checked)} disabled={loading || saving || resetting} />
                  启用 LLM 连通性探测
                </label>
                <label className="config-inline-check">
                  <input type="checkbox" checked={Boolean(config.review_llm_connectivity_strict)} onChange={(e) => setField('review_llm_connectivity_strict', e.target.checked)} disabled={loading || saving || resetting} />
                  连通性失败时严格中断
                </label>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    探测超时（秒）
                    <input type="number" step="0.1" value={config.review_llm_connectivity_timeout_seconds} onChange={(e) => setField('review_llm_connectivity_timeout_seconds', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                  <label style={labelStyle}>
                    探测缓存 TTL（秒）
                    <input type="number" step="0.1" value={config.review_llm_connectivity_probe_ttl_seconds} onChange={(e) => setField('review_llm_connectivity_probe_ttl_seconds', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                </div>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    最大重试次数
                    <input type="number" value={config.review_llm_request_max_retries} onChange={(e) => setField('review_llm_request_max_retries', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                  <label style={labelStyle}>
                    重试退避（秒）
                    <input type="number" step="0.1" value={config.review_llm_request_retry_backoff_seconds} onChange={(e) => setField('review_llm_request_retry_backoff_seconds', e.target.value)} style={inputStyle(loading)} disabled={loading || saving || resetting} />
                  </label>
                </div>
              </>
            ) : null}

            {page === 'ui' ? (
              <>
                <label style={labelStyle}>
                  默认折叠的 JSON 键名（逗号分隔）
                  <input
                    type="text"
                    value={uiConfig.defaultFoldedKeys}
                    onChange={(e) => setUiConfig((prev) => ({ ...prev, defaultFoldedKeys: e.target.value }))}
                    placeholder="如: extracted_text,bbox"
                    style={inputStyle(false)}
                    disabled={saving || resetting}
                  />
                </label>
                <label style={labelStyle}>
                  默认生词本目录
                  <select
                    value={uiConfig.defaultCategory}
                    onChange={(e) => setUiConfig((prev) => ({ ...prev, defaultCategory: e.target.value }))}
                    style={inputStyle(false)}
                    disabled={saving || resetting}
                  >
                    <option value="">请选择目录</option>
                    {categories.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </label>
                <div className="config-info-box">
                  这一页保存的是浏览器本地界面偏好，不需要重启服务。
                </div>
              </>
            ) : null}
          </div>

          <div className="config-modal-footer">
            <div className={`config-status${statusKind === 'error' ? ' is-error' : statusMsg ? ' is-success' : ''}`}>
              {statusMsg}
            </div>
            <div className="config-actions">
              <button type="button" className="master-secondary-button" onClick={onClose} disabled={saving || resetting}>
                取消
              </button>
              <button type="button" className="master-secondary-button" onClick={handleResetDefaults} disabled={loading || saving || resetting}>
                {resetting ? '同步中...' : '同步默认设置'}
              </button>
              <button type="submit" className="master-primary-button" disabled={loading || saving || resetting}>
                {saving ? '保存中...' : loading ? '读取中...' : '保存设置'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
