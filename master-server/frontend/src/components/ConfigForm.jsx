import React, { useEffect, useRef, useState } from 'react';

import { fetchConfig, resetConfig, saveConfig, testLlmConfig } from '../api/client';
import {
  DEFAULT_TTS_CONFIG,
  TTS_VOICE_SOURCE_PREFERENCES,
  formatTtsVoiceLabel,
  loadSpeechVoices,
  normalizeTtsConfig,
  pickPreferredVoice,
} from '../utils/tts.js';

const DEFAULT_PROVIDER = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.5-flash';
const DEFAULT_UI_CONFIG = {
  defaultFoldedKeys: 'extracted_text,bbox',
  vocabWorkspaceAutoLlmOnOpen: true,
};
const VOCAB_WORKSPACE_AUTO_LLM_KEY = 'vocabWorkspaceAutoLlmOnOpen';
const PAGES = [
  { id: 'llm', label: 'API' },
  { id: 'review', label: '参数' },
  { id: 'ui', label: '界面/语音' },
];
const LLM_TEST_LABELS = {
  connectivity: '连通性测试',
  minimal: '最小可用测试',
};

function readLocalUiConfig() {
  return {
    defaultFoldedKeys: localStorage.getItem('defaultFoldedKeys') ?? DEFAULT_UI_CONFIG.defaultFoldedKeys,
    vocabWorkspaceAutoLlmOnOpen: localStorage.getItem(VOCAB_WORKSPACE_AUTO_LLM_KEY) !== '0',
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

export default function ConfigForm({ onClose }) {
  const [page, setPage] = useState(PAGES[0].id);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [testingKind, setTestingKind] = useState('');
  const [ttsTestingLang, setTtsTestingLang] = useState('');
  const [llmTestResult, setLlmTestResult] = useState(null);
  const [ttsTestResult, setTtsTestResult] = useState(null);
  const [ttsTestText, setTtsTestText] = useState('example');
  const [statusMsg, setStatusMsg] = useState('');
  const [statusKind, setStatusKind] = useState('success');
  const ttsTestRequestRef = useRef(0);
  const modalBusyRef = useRef(false);
  const [config, setConfig] = useState({
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    api_key: '',
    hasKey: false,
    ...DEFAULT_TTS_CONFIG,
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
    modalBusyRef.current = saving || resetting || Boolean(testingKind || ttsTestingLang);
  }, [saving, resetting, testingKind, ttsTestingLang]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !modalBusyRef.current) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      ttsTestRequestRef.current += 1;
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, [onClose]);

  const setField = (key, value) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    if (key === 'provider' || key === 'model' || key === 'api_key') {
      setLlmTestResult(null);
    }
    if (key === 'tts_voice_source_preference' || key === 'tts_voice_priority') {
      setTtsTestResult(null);
    }
  };

  const buildServerConfigPayload = () => ({
    provider: config.provider,
    model: config.model,
    api_key: config.api_key,
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
    ...normalizeTtsConfig(config),
  });

  const handleRunLlmTest = async (testType) => {
    setTestingKind(testType);
    setStatusMsg('');
    setLlmTestResult(null);

    try {
      const response = await testLlmConfig({
        ...buildServerConfigPayload(),
        test_type: testType,
      });
      const result = response.data || {};
      const ok = Boolean(result.ok);
      const label = LLM_TEST_LABELS[testType] || '测试';
      const elapsed = Number.isFinite(Number(result.elapsed_ms)) ? `（${Math.round(Number(result.elapsed_ms))}ms）` : '';
      setLlmTestResult(result);
      setStatusKind(ok ? 'success' : 'error');
      setStatusMsg(`${label}${ok ? '通过' : '失败'}${elapsed}`);
    } catch (err) {
      setStatusKind('error');
      setStatusMsg(`测试失败: ${err.message}`);
      setLlmTestResult({
        kind: testType,
        ok: false,
        error: err.message,
      });
    } finally {
      setTestingKind('');
    }
  };

  const handleRunTtsTest = async (lang, label) => {
    const requestId = ttsTestRequestRef.current + 1;
    ttsTestRequestRef.current = requestId;
    setTtsTestingLang(lang);
    setTtsTestResult(null);
    setStatusMsg('');

    if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') {
      setTtsTestingLang('');
      setStatusKind('error');
      setStatusMsg('当前浏览器不支持语音朗读。');
      setTtsTestResult({ ok: false, error: '当前浏览器不支持语音朗读。' });
      return;
    }

    try {
      const synth = window.speechSynthesis;
      const text = String(ttsTestText || '').trim() || 'example';
      const voices = await loadSpeechVoices(synth);
      if (ttsTestRequestRef.current !== requestId) return;
      synth.cancel();

      const ttsSelectionConfig = normalizeTtsConfig(config);
      const voice = pickPreferredVoice(voices, lang, ttsSelectionConfig);
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = 0.9;
      if (voice) {
        utterance.voice = voice;
      }

      const voiceLabel = formatTtsVoiceLabel(voice);
      utterance.onend = () => {
        if (ttsTestRequestRef.current === requestId) {
          setTtsTestingLang('');
        }
      };
      utterance.onerror = (event) => {
        if (ttsTestRequestRef.current !== requestId) return;
        setTtsTestingLang('');
        const error = event?.error || '播放失败';
        setStatusKind('error');
        setStatusMsg(`语音测试失败: ${error}`);
        setTtsTestResult({ ok: false, error, lang, label, voiceLabel });
      };

      setStatusKind('success');
      setStatusMsg(`语音测试已开始: ${voiceLabel}`);
      setTtsTestResult({
        ok: true,
        lang,
        label,
        text,
        voiceLabel,
        voiceName: voice?.name || '',
        voiceLang: voice?.lang || '',
        voiceSource: voice ? (voice.localService === false || voice.remote ? 'remote' : 'local') : 'browser_default',
        voiceCount: voices.length,
      });
      synth.speak(utterance);
    } catch (err) {
      setStatusKind('error');
      setStatusMsg(`语音测试失败: ${err.message}`);
      setTtsTestResult({ ok: false, error: err.message, lang, label });
    } finally {
      if (ttsTestRequestRef.current === requestId) {
        window.setTimeout(() => {
          if (ttsTestRequestRef.current === requestId) {
            setTtsTestingLang('');
          }
        }, 1200);
      }
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setStatusMsg('');

    const payload = buildServerConfigPayload();

    try {
      const data = await saveConfig(payload);

      localStorage.setItem('defaultFoldedKeys', uiConfig.defaultFoldedKeys);
      localStorage.setItem(VOCAB_WORKSPACE_AUTO_LLM_KEY, uiConfig.vocabWorkspaceAutoLlmOnOpen ? '1' : '0');
      window.dispatchEvent(new Event('config-updated'));

      setConfig((prev) => ({
        ...prev,
        ...(data.data || {}),
        api_key: '',
        hasKey: Boolean(data?.data?.hasKey ?? true),
      }));
      setStatusKind('success');
      setStatusMsg('设置已保存。');
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
      const preservedRuntimePorts = {};
      if (Number.isFinite(Number(config.frontend_port))) {
        preservedRuntimePorts.frontend_port = numberValue(config.frontend_port, 8000);
      }
      if (Number.isFinite(Number(config.backend_port))) {
        preservedRuntimePorts.backend_port = numberValue(config.backend_port, 8080);
      }

      const data = await resetConfig();
      let nextServerConfig = data.data || {};
      if (Object.keys(preservedRuntimePorts).length) {
        const restored = await saveConfig(preservedRuntimePorts);
        nextServerConfig = restored.data || nextServerConfig;
      }
      const nextUiConfig = { ...DEFAULT_UI_CONFIG };

      localStorage.setItem('defaultFoldedKeys', nextUiConfig.defaultFoldedKeys);
      localStorage.setItem(VOCAB_WORKSPACE_AUTO_LLM_KEY, nextUiConfig.vocabWorkspaceAutoLlmOnOpen ? '1' : '0');
      setUiConfig(nextUiConfig);

      setConfig((prev) => ({
        ...prev,
        ...nextServerConfig,
        api_key: '',
        hasKey: Boolean(nextServerConfig?.hasKey),
      }));

      window.dispatchEvent(new Event('config-updated'));

      setStatusKind('success');
      setStatusMsg('已同步为默认设置。');
    } catch (err) {
      setStatusKind('error');
      setStatusMsg(`同步默认设置失败: ${err.message}`);
    } finally {
      setResetting(false);
    }
  };

  const labelStyle = { display: 'flex', flexDirection: 'column', fontSize: '13px', color: 'var(--ms-text)', fontWeight: '600', width: '100%' };
  const rowStyle = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' };
  const isTesting = Boolean(testingKind || ttsTestingLang);
  const serverBusy = loading || saving || resetting || isTesting;
  const modalBusy = saving || resetting || isTesting;

  return (
    <div className="config-modal">
      <div className="config-modal-card">
        <div className="config-modal-header">
          <div>
            <h2 className="config-modal-title">全局设置</h2>
            <div className="config-modal-subtitle">
              服务端配置写入本地配置文件，界面偏好保存在当前浏览器。
            </div>
          </div>
          <button type="button" className="config-modal-close" onClick={onClose} disabled={modalBusy}>✕</button>
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
                <label style={labelStyle}>
                  接口地址 (Provider API)
                  <input type="text" value={config.provider} onChange={(e) => setField('provider', e.target.value)} style={inputStyle(serverBusy)} required disabled={serverBusy} />
                </label>
                <div className="config-info-box">
                  支持直接填写 Base URL，例如 `https://dashscope.aliyuncs.com/compatible-mode/v1`；系统会自动补全 `/chat/completions`。
                </div>
                <label style={labelStyle}>
                  模型名称 (Model)
                  <input type="text" value={config.model} onChange={(e) => setField('model', e.target.value)} style={inputStyle(serverBusy)} required disabled={serverBusy} />
                </label>
                <label style={labelStyle}>
                  API Key {config.hasKey ? <span style={{ color: 'var(--ms-text-muted)', fontSize: '12px', fontWeight: 500, marginLeft: '6px' }}>(已保存)</span> : null}
                  <input
                    type="password"
                    value={config.api_key}
                    onChange={(e) => setField('api_key', e.target.value)}
                    placeholder={config.hasKey ? '留空则保持原密钥' : '输入新的 API Key'}
                    style={inputStyle(serverBusy)}
                    disabled={serverBusy}
                  />
                </label>
                <div className="config-test-actions">
                  <button
                    type="button"
                    className="master-secondary-button"
                    onClick={() => handleRunLlmTest('connectivity')}
                    disabled={serverBusy}
                  >
                    {testingKind === 'connectivity' ? '测试中...' : '连通性测试'}
                  </button>
                  <button
                    type="button"
                    className="master-secondary-button"
                    onClick={() => handleRunLlmTest('minimal')}
                    disabled={serverBusy}
                  >
                    {testingKind === 'minimal' ? '测试中...' : '最小可用测试'}
                  </button>
                </div>
                {llmTestResult ? (
                  <div className={`config-test-result${llmTestResult.ok ? ' is-success' : ' is-error'}`}>
                    <div className="config-test-result-title">
                      {(LLM_TEST_LABELS[llmTestResult.kind] || '测试')}{llmTestResult.ok ? '通过' : '失败'}
                    </div>
                    <dl className="config-test-result-grid">
                      {llmTestResult.request_url ? (
                        <>
                          <dt>实际地址</dt>
                          <dd><code>{llmTestResult.request_url}</code></dd>
                        </>
                      ) : null}
                      {llmTestResult.model ? (
                        <>
                          <dt>模型</dt>
                          <dd>{llmTestResult.model}</dd>
                        </>
                      ) : null}
                      {llmTestResult.status_code ? (
                        <>
                          <dt>HTTP</dt>
                          <dd>{llmTestResult.status_code}</dd>
                        </>
                      ) : null}
                      {llmTestResult.elapsed_ms !== undefined ? (
                        <>
                          <dt>耗时</dt>
                          <dd>{Math.round(Number(llmTestResult.elapsed_ms) || 0)}ms</dd>
                        </>
                      ) : null}
                      {llmTestResult.response_schema ? (
                        <>
                          <dt>响应结构</dt>
                          <dd>{llmTestResult.response_schema}</dd>
                        </>
                      ) : null}
                    </dl>
                    {Array.isArray(llmTestResult.warnings) && llmTestResult.warnings.length ? (
                      <div className="config-test-warnings">
                        {llmTestResult.warnings.map((warning, index) => (
                          <div key={`${warning}-${index}`}>{warning}</div>
                        ))}
                      </div>
                    ) : null}
                    {llmTestResult.message ? <div>{llmTestResult.message}</div> : null}
                    {llmTestResult.error ? <div className="config-test-error">{llmTestResult.error}</div> : null}
                    {llmTestResult.body_excerpt ? <pre className="config-test-excerpt">{llmTestResult.body_excerpt}</pre> : null}
                    {llmTestResult.content_excerpt ? <pre className="config-test-excerpt">{llmTestResult.content_excerpt}</pre> : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {page === 'review' ? (
              <>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    Review LLM 超时（秒）
                    <input type="number" step="0.1" value={config.review_llm_timeout_seconds} onChange={(e) => setField('review_llm_timeout_seconds', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                  </label>
                  <label style={labelStyle}>
                    目录合并超时（秒）
                    <input type="number" step="0.1" value={config.review_folder_merge_llm_timeout_seconds} onChange={(e) => setField('review_folder_merge_llm_timeout_seconds', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                  </label>
                </div>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    目录合并输出 Token
                    <input type="number" value={config.review_folder_merge_llm_max_tokens} onChange={(e) => setField('review_folder_merge_llm_max_tokens', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                  </label>
                  <label style={labelStyle}>
                    目录合并 Token 上限
                    <input type="number" value={config.review_folder_merge_llm_max_tokens_cap} onChange={(e) => setField('review_folder_merge_llm_max_tokens_cap', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                  </label>
                </div>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    最多建议数
                    <input type="number" value={config.review_folder_merge_max_suggestions} onChange={(e) => setField('review_folder_merge_max_suggestions', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                  </label>
                  <label style={labelStyle}>
                    目录裁剪词数
                    <input type="number" value={config.review_folder_merge_word_limit} onChange={(e) => setField('review_folder_merge_word_limit', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                  </label>
                </div>
                <label style={labelStyle}>
                  目录合并温度
                  <input type="number" step="0.1" value={config.review_folder_merge_temperature} onChange={(e) => setField('review_folder_merge_temperature', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                </label>
                <div style={{ height: '1px', background: 'var(--ms-border)' }} />
                <label className="config-inline-check">
                  <input type="checkbox" checked={Boolean(config.review_llm_connectivity_check)} onChange={(e) => setField('review_llm_connectivity_check', e.target.checked)} disabled={serverBusy} />
                  启用 LLM 连通性探测
                </label>
                <label className="config-inline-check">
                  <input type="checkbox" checked={Boolean(config.review_llm_connectivity_strict)} onChange={(e) => setField('review_llm_connectivity_strict', e.target.checked)} disabled={serverBusy} />
                  连通性失败时严格中断
                </label>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    探测超时（秒）
                    <input type="number" step="0.1" value={config.review_llm_connectivity_timeout_seconds} onChange={(e) => setField('review_llm_connectivity_timeout_seconds', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                  </label>
                  <label style={labelStyle}>
                    探测缓存 TTL（秒）
                    <input type="number" step="0.1" value={config.review_llm_connectivity_probe_ttl_seconds} onChange={(e) => setField('review_llm_connectivity_probe_ttl_seconds', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                  </label>
                </div>
                <div style={rowStyle}>
                  <label style={labelStyle}>
                    最大重试次数
                    <input type="number" value={config.review_llm_request_max_retries} onChange={(e) => setField('review_llm_request_max_retries', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
                  </label>
                  <label style={labelStyle}>
                    重试退避（秒）
                    <input type="number" step="0.1" value={config.review_llm_request_retry_backoff_seconds} onChange={(e) => setField('review_llm_request_retry_backoff_seconds', e.target.value)} style={inputStyle(serverBusy)} disabled={serverBusy} />
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
                    disabled={modalBusy}
                  />
                </label>
                <label className="config-inline-check">
                  <input
                    type="checkbox"
                    checked={Boolean(uiConfig.vocabWorkspaceAutoLlmOnOpen)}
                    onChange={(e) => setUiConfig((prev) => ({ ...prev, vocabWorkspaceAutoLlmOnOpen: e.target.checked }))}
                    disabled={modalBusy}
                  />
                  打开生词本编辑/连接面板时自动生成 LLM 建议
                </label>
                <div style={{ height: '1px', background: 'var(--ms-border)' }} />
                <label style={labelStyle}>
                  语音来源
                  <select
                    value={config.tts_voice_source_preference}
                    onChange={(e) => setField('tts_voice_source_preference', e.target.value)}
                    style={inputStyle(modalBusy)}
                    disabled={modalBusy}
                  >
                    {TTS_VOICE_SOURCE_PREFERENCES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <label style={labelStyle}>
                  语音优先级
                  <textarea
                    value={config.tts_voice_priority}
                    onChange={(e) => setField('tts_voice_priority', e.target.value)}
                    placeholder="如: Microsoft Aria Online, local:en-US, en-GB"
                    style={{ ...inputStyle(modalBusy), minHeight: '74px', resize: 'vertical' }}
                    disabled={modalBusy}
                  />
                </label>
                <label style={labelStyle}>
                  测试文本
                  <input
                    type="text"
                    value={ttsTestText}
                    onChange={(e) => setTtsTestText(e.target.value)}
                    style={inputStyle(modalBusy)}
                    disabled={modalBusy}
                  />
                </label>
                <div className="config-test-actions">
                  <button
                    type="button"
                    className="master-secondary-button"
                    onClick={() => handleRunTtsTest('en-US', '美音')}
                    disabled={modalBusy}
                  >
                    {ttsTestingLang === 'en-US' ? '测试中...' : '测试美音'}
                  </button>
                  <button
                    type="button"
                    className="master-secondary-button"
                    onClick={() => handleRunTtsTest('en-GB', '英音')}
                    disabled={modalBusy}
                  >
                    {ttsTestingLang === 'en-GB' ? '测试中...' : '测试英音'}
                  </button>
                </div>
                {ttsTestResult ? (
                  <div className={`config-test-result${ttsTestResult.ok ? ' is-success' : ' is-error'}`}>
                    <div className="config-test-result-title">
                      {ttsTestResult.ok ? '语音测试已发送' : '语音测试失败'}
                    </div>
                    {ttsTestResult.ok ? (
                      <dl className="config-test-result-grid">
                        <dt>目标</dt>
                        <dd>{ttsTestResult.label} · {ttsTestResult.lang}</dd>
                        <dt>声音</dt>
                        <dd>{ttsTestResult.voiceLabel}</dd>
                        <dt>可用声音</dt>
                        <dd>{ttsTestResult.voiceCount}</dd>
                      </dl>
                    ) : null}
                    {ttsTestResult.error ? <div className="config-test-error">{ttsTestResult.error}</div> : null}
                  </div>
                ) : null}
                <div className="config-info-box">
                  界面偏好保存在当前浏览器；语音设置会写入全局配置，保存后复习页立即使用。
                </div>
              </>
            ) : null}
          </div>

          <div className="config-modal-footer">
            <div className={`config-status${statusKind === 'error' ? ' is-error' : statusMsg ? ' is-success' : ''}`}>
              {statusMsg}
            </div>
            <div className="config-actions">
              <button type="button" className="master-secondary-button" onClick={onClose} disabled={modalBusy}>
                取消
              </button>
              <button type="button" className="master-secondary-button" onClick={handleResetDefaults} disabled={serverBusy}>
                {resetting ? '同步中...' : '同步默认设置'}
              </button>
              <button type="submit" className="master-primary-button" disabled={serverBusy}>
                {saving ? '保存中...' : loading ? '读取中...' : '保存设置'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
