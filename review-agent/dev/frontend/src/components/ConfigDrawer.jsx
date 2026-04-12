import { useEffect, useState } from 'react';

import { fetchConfig, saveConfig } from '../api/client';

export default function ConfigDrawer({ open, onClose }) {
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setLoading(true);
    setError('');

    fetchConfig()
      .then((data) => {
        if (cancelled) return;
        setProvider(data.provider || '');
        setModel(data.model || '');
        setHasKey(Boolean(data.hasKey));
        setApiKey('');
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        setProvider('');
        setModel('');
        setHasKey(false);
        setApiKey('');
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
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !saving) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, saving]);

  const onSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');

    try {
      await saveConfig(provider, model, apiKey);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="overlay" onClick={() => { if (!saving) onClose(); }}>
      <div className="drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <h3>LLM 配置</h3>
          <button type="button" className="ghost" onClick={onClose} disabled={saving}>关闭</button>
        </div>

        <form onSubmit={onSubmit} className="drawer-form">
          <label>
            Provider
            <input value={provider} onChange={(event) => setProvider(event.target.value)} required disabled={loading || saving} />
          </label>

          <label>
            Model
            <input value={model} onChange={(event) => setModel(event.target.value)} required disabled={loading || saving} />
          </label>

          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={hasKey ? '留空则保留已保存密钥' : '输入新的 API Key'}
              disabled={loading || saving}
            />
          </label>

          <div className="muted">
            {loading ? '正在读取当前配置...' : hasKey ? '已检测到已保存密钥，可只更新 provider/model。' : '当前尚未保存 API Key。'}
          </div>

          {error ? <div className="error">{error}</div> : null}

          <button className="primary" type="submit" disabled={loading || saving}>
            {saving ? '保存中...' : loading ? '读取中...' : '保存配置'}
          </button>
        </form>
      </div>
    </div>
  );
}
