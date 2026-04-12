const envBackendUrl = String(import.meta.env.VITE_BACKEND_URL || '').trim();
const backendPort = String(import.meta.env.VITE_BACKEND_PORT || '').trim() || '8090';
const host = window.location.hostname || 'localhost';
const protocol = window.location.protocol || 'http:';
const BACKEND_URL = envBackendUrl || `${protocol}//${host}:${backendPort}`;

const readErrorMessage = async (res) => {
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const payload = await res.json().catch(() => null);
    const detail = payload?.detail || payload?.message;
    if (typeof detail === 'string' && detail.trim()) {
      return detail.trim();
    }
    if (detail && typeof detail === 'object') {
      return JSON.stringify(detail);
    }
    if (typeof payload?.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
  }

  const text = await res.text().catch(() => '');
  return text.trim();
};

const requestJson = async (path, options) => {
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, options);
    if (!res.ok) {
      const message = await readErrorMessage(res);
      throw new Error(message ? `请求失败(${res.status}): ${message}` : `请求失败(${res.status})`);
    }
    return res.json();
  } catch (error) {
    if (error instanceof Error && /Failed to fetch/i.test(error.message)) {
      throw new Error(`无法连接后端 ${BACKEND_URL}`);
    }
    throw error;
  }
};

export const fetchConfig = async () => {
  return requestJson('/api/config');
};

export const saveConfig = async (provider, model, apiKey) => {
  const form = new FormData();
  form.append('provider', provider);
  form.append('model', model);
  form.append('api_key', apiKey || '');
  return requestJson('/api/config', {
    method: 'POST',
    body: form,
  });
};

export const fetchCategories = async () => {
  return requestJson('/api/vocabulary/categories');
};

export const fetchFiles = async (category) => {
  return requestJson(`/api/vocabulary/list?category=${encodeURIComponent(category)}`);
};

export const fetchVocabDetail = async (category, filename) => {
  return requestJson(`/api/vocabulary/detail/${encodeURIComponent(filename)}?category=${encodeURIComponent(category)}`);
};

export const runFolderRefine = async (category, includeLowConfidence = false, includeLlm = true) => {
  return requestJson('/api/refine/folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category,
      include_low_confidence: includeLowConfidence,
      include_llm: includeLlm,
    }),
  });
};

export const applyMergeSuggestion = async (
  category,
  sourceFilename,
  targetFilename,
  deleteSource = false,
  createTargetIfMissing = false,
) => {
  return requestJson('/api/refine/merge/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category,
      source_filename: sourceFilename,
      target_filename: targetFilename,
      delete_source: deleteSource,
      create_target_if_missing: createTargetIfMissing,
    }),
  });
};

export const runFileRefine = async (category, filename, includeLlm = true, data = null) => {
  return requestJson('/api/refine/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category,
      filename,
      include_llm: includeLlm,
      data,
    }),
  });
};

export const saveVocabDetail = async (category, filename, data) => {
  return requestJson('/api/vocabulary/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category,
      filename,
      data,
    }),
  });
};

export const getReviewAdvice = async (category, filename) => {
  return requestJson('/api/review/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category,
      filename,
      auto_save: false,
    }),
  });
};

export const submitReviewScore = async (category, filename, score, reviewDate) => {
  return requestJson('/api/review/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category,
      filename,
      score,
      review_date: reviewDate,
      auto_save: true,
    }),
  });
};

export const fetchRecommendedWord = async (category = '', excludeKeys = [], limit = 5) => {
  return requestJson('/api/review/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: category || null,
      exclude_keys: excludeKeys,
      limit,
    }),
  });
};
