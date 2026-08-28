import { useEffect, useRef, useState } from 'react';

import { fetchConfig, resetConfig, saveConfig } from '../api/client';
import {
  DEFAULT_TTS_CONFIG,
  TTS_VOICE_SOURCE_PREFERENCES,
  formatTtsVoiceLabel,
  loadSpeechVoices,
  normalizeTtsConfig,
  pickPreferredVoice,
} from '../../utils/tts.js';

export default function ConfigDrawer({ open, onClose }) {
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [ttsConfig, setTtsConfig] = useState(() => normalizeTtsConfig(DEFAULT_TTS_CONFIG));
  const [ttsTestText, setTtsTestText] = useState('example');
  const [ttsTestingLang, setTtsTestingLang] = useState('');
  const [ttsTestResult, setTtsTestResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const ttsTestRequestRef = useRef(0);
  const busy = loading || saving || resetting || Boolean(ttsTestingLang);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setLoading(true);
    setError('');
    setNotice('');

    fetchConfig()
      .then((data) => {
        if (cancelled) return;
        setProvider(data.provider || '');
        setModel(data.model || '');
        setHasKey(Boolean(data.hasKey));
        setApiKey('');
        setTtsConfig(normalizeTtsConfig(data || {}));
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        setProvider('');
        setModel('');
        setHasKey(false);
        setApiKey('');
        setTtsConfig(normalizeTtsConfig(DEFAULT_TTS_CONFIG));
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      document.body.style.overflow = previousOverflow;
      ttsTestRequestRef.current += 1;
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !saving && !resetting && !ttsTestingLang) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, saving, resetting, ttsTestingLang]);

  const setTtsField = (key, value) => {
    setTtsConfig((current) => normalizeTtsConfig({ ...current, [key]: value }));
    setTtsTestResult(null);
  };

  const onRunTtsTest = async (lang, label) => {
    const requestId = ttsTestRequestRef.current + 1;
    ttsTestRequestRef.current = requestId;
    setTtsTestingLang(lang);
    setTtsTestResult(null);
    setError('');
    setNotice('');

    if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') {
      setTtsTestingLang('');
      setError('当前浏览器不支持语音朗读。');
      setTtsTestResult({ ok: false, error: '当前浏览器不支持语音朗读。' });
      return;
    }

    try {
      const synth = window.speechSynthesis;
      const voices = await loadSpeechVoices(synth);
      if (ttsTestRequestRef.current !== requestId) return;
      synth.cancel();

      const text = String(ttsTestText || '').trim() || 'example';
      const voice = pickPreferredVoice(voices, lang, ttsConfig);
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
        const message = event?.error || '播放失败';
        setTtsTestingLang('');
        setError(`语音测试失败: ${message}`);
        setTtsTestResult({ ok: false, error: message, label, lang, voiceLabel });
      };

      setNotice(`语音测试已开始: ${voiceLabel}`);
      setTtsTestResult({
        ok: true,
        label,
        lang,
        voiceLabel,
        voiceCount: voices.length,
      });
      synth.speak(utterance);
    } catch (err) {
      setError(`语音测试失败: ${err.message}`);
      setTtsTestResult({ ok: false, error: err.message, label, lang });
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

  const onSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');

    try {
      await saveConfig({
        provider,
        model,
        api_key: apiKey || '',
        ...normalizeTtsConfig(ttsConfig),
      });
      window.dispatchEvent(new Event('config-updated'));
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const onResetDefaults = async () => {
    setResetting(true);
    setError('');
    setNotice('');

    try {
      const data = await resetConfig();
      const nextConfig = data?.data || {};
      setProvider(nextConfig.provider || '');
      setModel(nextConfig.model || '');
      setHasKey(Boolean(nextConfig.hasKey));
      setApiKey('');
      setTtsConfig(normalizeTtsConfig(nextConfig || {}));
      setTtsTestResult(null);

      localStorage.setItem('defaultFoldedKeys', 'extracted_text,bbox');
      localStorage.setItem('defaultCategory', '');
      localStorage.removeItem('vocabReviewCategory');
      window.dispatchEvent(new CustomEvent('config-updated', { detail: { category: '' } }));
      window.dispatchEvent(new CustomEvent('default-category-updated', { detail: { category: '' } }));
      setNotice('已同步为默认设置。');
    } catch (err) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="overlay">
      <div className="drawer">
        <div className="drawer-header">
          <h3>全局配置</h3>
          <button type="button" className="ghost" onClick={onClose} disabled={saving || resetting || Boolean(ttsTestingLang)}>关闭</button>
        </div>

        <form onSubmit={onSubmit} className="drawer-form">
          <label>
            Provider
            <input value={provider} onChange={(event) => setProvider(event.target.value)} required disabled={busy} />
          </label>

          <div className="muted">
            支持填写 Base URL，保存时会自动兼容 `/chat/completions`。
          </div>

          <label>
            Model
            <input value={model} onChange={(event) => setModel(event.target.value)} required disabled={busy} />
          </label>

          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={hasKey ? '留空则保留已保存密钥' : '输入新的 API Key'}
              disabled={busy}
            />
          </label>

          <div className="muted">
            {loading ? '正在读取当前配置...' : hasKey ? '已检测到已保存密钥，可只更新 provider/model。' : '当前尚未保存 API Key。'}
          </div>

          <div className="drawer-section-title">语音朗读</div>

          <label>
            语音来源
            <select
              value={ttsConfig.tts_voice_source_preference}
              onChange={(event) => setTtsField('tts_voice_source_preference', event.target.value)}
              disabled={busy}
            >
              {TTS_VOICE_SOURCE_PREFERENCES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>

          <label>
            语音优先级
            <textarea
              value={ttsConfig.tts_voice_priority}
              onChange={(event) => setTtsField('tts_voice_priority', event.target.value)}
              placeholder="如: Microsoft Aria Online, local:en-US, en-GB"
              rows={3}
              disabled={busy}
            />
          </label>

          <label>
            测试文本
            <input
              value={ttsTestText}
              onChange={(event) => setTtsTestText(event.target.value)}
              disabled={busy}
            />
          </label>

          <div className="drawer-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => onRunTtsTest('en-US', '美音')}
              disabled={busy}
            >
              {ttsTestingLang === 'en-US' ? '测试中...' : '测试美音'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => onRunTtsTest('en-GB', '英音')}
              disabled={busy}
            >
              {ttsTestingLang === 'en-GB' ? '测试中...' : '测试英音'}
            </button>
          </div>

          {ttsTestResult ? (
            <div className={ttsTestResult.ok ? 'success' : 'error'}>
              {ttsTestResult.ok
                ? `${ttsTestResult.label}使用: ${ttsTestResult.voiceLabel}（${ttsTestResult.voiceCount} 个可用声音）`
                : ttsTestResult.error}
            </div>
          ) : null}

          {notice ? <div className="success">{notice}</div> : null}
          {error ? <div className="error">{error}</div> : null}

          <div className="drawer-actions">
            <button type="button" className="ghost" onClick={onResetDefaults} disabled={busy}>
              {resetting ? '同步中...' : '同步默认设置'}
            </button>
            <button className="primary" type="submit" disabled={busy}>
            {saving ? '保存中...' : loading ? '读取中...' : '保存配置'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
