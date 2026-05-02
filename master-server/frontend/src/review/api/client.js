const envBackendUrl = String(import.meta.env.VITE_BACKEND_URL || '').trim();
const backendPort = String(import.meta.env.VITE_BACKEND_PORT || '').trim() || '8080';
const host = window.location.hostname || 'localhost';
const protocol = window.location.protocol || 'http:';
const currentOrigin = window.location.origin || `${protocol}//${host}`;
const devBackendUrl = `${protocol}//${host}:${backendPort}`;
const BACKEND_URL = envBackendUrl || (import.meta.env.DEV ? devBackendUrl : currentOrigin);

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

const requireCategory = (category) => {
  const normalized = String(category || '').trim();
  if (!normalized) {
    throw new Error('保存目录不能为空，必须使用 data/文件夹/');
  }
  return normalized;
};

export const fetchConfig = async () => {
  return requestJson('/api/config');
};

export const saveConfig = async (payload) => {
  return requestJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
};

export const resetConfig = async () => {
  return requestJson('/api/config/reset', { method: 'POST' });
};

export const fetchCategories = async () => {
  return requestJson('/api/vocabulary/categories');
};

export const fetchFiles = async (category) => {
  const finalCategory = requireCategory(category);
  return requestJson(`/api/vocabulary/list?category=${encodeURIComponent(finalCategory)}`);
};

export const fetchVocabDetail = async (category, filename) => {
  const finalCategory = requireCategory(category);
  return requestJson(`/api/vocabulary/detail/${encodeURIComponent(filename)}?category=${encodeURIComponent(finalCategory)}`);
};

export const runFolderRefine = async (category, includeLowConfidence = false, includeLlm = true) => {
  const finalCategory = requireCategory(category);
  return requestJson('/api/refine/folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: finalCategory,
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
  const finalCategory = requireCategory(category);
  return requestJson('/api/refine/merge/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: finalCategory,
      source_filename: sourceFilename,
      target_filename: targetFilename,
      delete_source: deleteSource,
      create_target_if_missing: createTargetIfMissing,
    }),
  });
};

export const applySplitSuggestion = async (
  category,
  sourceFilename,
  suggestion,
  deleteSource = true,
  data = null,
) => {
  const finalCategory = requireCategory(category);
  return requestJson('/api/refine/split/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: finalCategory,
      source_filename: sourceFilename,
      suggestion,
      delete_source: deleteSource,
      data,
    }),
  });
};

export const runFileRefine = async (category, filename, includeLlm = true, data = null) => {
  const finalCategory = requireCategory(category);
  return requestJson('/api/refine/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: finalCategory,
      filename,
      include_llm: includeLlm,
      data,
    }),
  });
};

export const saveVocabDetail = async (category, filename, data) => {
  const finalCategory = requireCategory(category);
  return requestJson('/api/vocabulary/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: finalCategory,
      filename,
      data,
    }),
  });
};

export const renameVocabDetail = async (category, filename, word, data = null) => {
  const finalCategory = requireCategory(category);
  return requestJson('/api/vocabulary/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: finalCategory,
      filename,
      word,
      data,
    }),
  });
};

export const getReviewAdvice = async (category, filename) => {
  const finalCategory = requireCategory(category);
  return requestJson('/api/review/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: finalCategory,
      filename,
      auto_save: false,
    }),
  });
};

export const submitReviewScore = async (category, filename, score, reviewDate) => {
  const finalCategory = requireCategory(category);
  return requestJson('/api/review/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: finalCategory,
      filename,
      score,
      review_date: reviewDate,
      auto_save: true,
    }),
  });
};

export const fetchRecommendedWord = async (category = '', excludeKeys = [], limit = 5, preferences = {}) => {
  return requestJson('/api/review/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: category || null,
      exclude_keys: excludeKeys,
      limit,
      ...(preferences || {}),
    }),
  });
};
