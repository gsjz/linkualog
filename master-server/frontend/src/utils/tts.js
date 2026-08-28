export const DEFAULT_TTS_CONFIG = {
  tts_voice_source_preference: 'local_first',
  tts_voice_priority: '',
};

export const TTS_VOICE_SOURCE_PREFERENCES = [
  {
    value: 'local_first',
    label: '本地优先',
    description: '优先使用系统本地声音，通常延迟更低。',
  },
  {
    value: 'remote_first',
    label: '远程优先',
    description: '优先使用浏览器提供的远程/在线声音。',
  },
  {
    value: 'browser_default',
    label: '浏览器默认',
    description: '未命中优先级列表时不指定声音，由浏览器选择。',
  },
];

const SOURCE_VALUES = new Set(TTS_VOICE_SOURCE_PREFERENCES.map((item) => item.value));

const normalizeText = (value) => String(value || '').trim();

const normalizeComparable = (value) => normalizeText(value).toLowerCase();

export function normalizeTtsVoiceSourcePreference(value) {
  const normalized = normalizeComparable(value);
  return SOURCE_VALUES.has(normalized)
    ? normalized
    : DEFAULT_TTS_CONFIG.tts_voice_source_preference;
}

export function normalizeTtsConfig(config = {}) {
  return {
    tts_voice_source_preference: normalizeTtsVoiceSourcePreference(
      config?.tts_voice_source_preference,
    ),
    tts_voice_priority: normalizeText(config?.tts_voice_priority),
  };
}

export function parseTtsVoicePriority(value) {
  return normalizeText(value)
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const sourceMatches = (voice, source) => {
  const isLocal = typeof voice?.localService === 'boolean'
    ? Boolean(voice.localService)
    : typeof voice?.remote === 'boolean'
      ? !voice.remote
      : null;
  if (source === 'local') return isLocal !== false;
  if (source === 'remote') return isLocal === false;
  return true;
};

const parsePriorityToken = (token) => {
  const normalized = normalizeText(token);
  const sourceMatch = normalized.match(/^(local|remote)\s*:\s*(.+)$/i);
  if (!sourceMatch) {
    return { source: '', value: normalized };
  }
  return {
    source: sourceMatch[1].toLowerCase(),
    value: sourceMatch[2].trim(),
  };
};

const voiceMatchesToken = (voice, token) => {
  const { source, value } = parsePriorityToken(token);
  if (!voice || !value || !sourceMatches(voice, source)) return false;

  const target = normalizeComparable(value);
  const name = normalizeComparable(voice.name);
  const voiceUri = normalizeComparable(voice.voiceURI);
  const voiceLang = normalizeComparable(voice.lang);
  if (!target) return false;

  if (name === target || voiceUri === target || voiceLang === target) {
    return true;
  }

  const targetIsLangBase = /^[a-z]{2,3}$/i.test(target);
  if (targetIsLangBase && voiceLang.split('-')[0] === target) {
    return true;
  }

  return name.includes(target) || voiceUri.includes(target);
};

const findLanguageVoice = (voices, lang, { source = '', exact = false } = {}) => {
  const normalizedLang = normalizeComparable(lang);
  if (!normalizedLang) return null;
  const baseLang = normalizedLang.split('-')[0];

  return voices.find((voice) => {
    if (!sourceMatches(voice, source)) return false;
    const voiceLang = normalizeComparable(voice?.lang);
    if (exact) return voiceLang === normalizedLang;
    return voiceLang === normalizedLang || voiceLang.startsWith(`${baseLang}-`);
  }) || null;
};

const findEnglishFallbackVoice = (voices, source = '') => voices.find((voice) => (
  sourceMatches(voice, source)
  && normalizeComparable(voice?.lang).startsWith('en')
)) || null;

export function pickPreferredVoice(voices, lang, config = {}) {
  const availableVoices = Array.isArray(voices)
    ? voices.filter(Boolean)
    : [];
  if (!availableVoices.length) return null;

  const normalizedConfig = normalizeTtsConfig(config);
  const priority = parseTtsVoicePriority(normalizedConfig.tts_voice_priority);
  for (const token of priority) {
    const matched = availableVoices.find((voice) => voiceMatchesToken(voice, token));
    if (matched) return matched;
  }

  const normalizedLang = normalizeComparable(lang);
  if (!normalizedLang) return null;
  if (normalizedConfig.tts_voice_source_preference === 'browser_default') {
    return null;
  }

  const preferredSource = normalizedConfig.tts_voice_source_preference === 'remote_first'
    ? 'remote'
    : 'local';
  const fallbackSource = preferredSource === 'remote' ? 'local' : 'remote';

  return findLanguageVoice(availableVoices, normalizedLang, { source: preferredSource, exact: true })
    || findLanguageVoice(availableVoices, normalizedLang, { source: preferredSource })
    || findLanguageVoice(availableVoices, normalizedLang, { source: fallbackSource, exact: true })
    || findLanguageVoice(availableVoices, normalizedLang, { source: fallbackSource })
    || findEnglishFallbackVoice(availableVoices, preferredSource)
    || findEnglishFallbackVoice(availableVoices, fallbackSource)
    || null;
}

export function warmSpeechVoices(synth) {
  if (!synth || typeof synth.getVoices !== 'function') return [];
  const voices = synth.getVoices();
  return Array.isArray(voices) ? voices : [];
}

export function loadSpeechVoices(synth, timeoutMs = 900) {
  const voices = warmSpeechVoices(synth);
  if (voices.length || !synth) return Promise.resolve(voices);

  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) globalThis.clearTimeout(timer);
      if (typeof synth.removeEventListener === 'function') {
        synth.removeEventListener('voiceschanged', finish);
      }
      if (synth.onvoiceschanged === finish) {
        synth.onvoiceschanged = null;
      }
      resolve(warmSpeechVoices(synth));
    };

    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', finish);
    } else {
      synth.onvoiceschanged = finish;
    }
    timer = globalThis.setTimeout(finish, timeoutMs);
  });
}

export function formatTtsVoiceLabel(voice) {
  if (!voice) return '浏览器默认';
  const isLocal = typeof voice.localService === 'boolean'
    ? Boolean(voice.localService)
    : typeof voice.remote === 'boolean'
      ? !voice.remote
      : null;
  const source = isLocal === false ? '远程' : '本地';
  const lang = normalizeText(voice.lang);
  const name = normalizeText(voice.name) || normalizeText(voice.voiceURI) || '未命名声音';
  return `${name}${lang ? ` · ${lang}` : ''} · ${source}`;
}
