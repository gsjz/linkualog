const envBackendUrl = String(import.meta.env.VITE_BACKEND_URL || '').trim();
const backendPort = String(import.meta.env.VITE_BACKEND_PORT || '').trim() || '8080';
const host = window.location.hostname || 'localhost';
const protocol = window.location.protocol || 'http:';
const currentOrigin = window.location.origin || `${protocol}//${host}`;
const devBackendUrl = `${protocol}//${host}:${backendPort}`;
const BACKEND_URL = envBackendUrl || (import.meta.env.DEV ? devBackendUrl : currentOrigin);

console.log('当前连接的后端地址:', BACKEND_URL);

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
  }

  return (await res.text().catch(() => '')).trim();
};

const handleResponse = async (res) => {
  if (!res.ok) {
    const errorText = await readErrorMessage(res);
    throw new Error(errorText ? `请求失败 (${res.status}): ${errorText}` : `请求失败 (${res.status})`);
  }
  return res.json();
};

export const fetchConfig = async () => {
  const res = await fetch(`${BACKEND_URL}/api/config`);
  return handleResponse(res);
};

export const saveConfig = async (payload) => {
  const res = await fetch(`${BACKEND_URL}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  return handleResponse(res);
};

export const uploadImage = async (formData) => {
  const res = await fetch(`${BACKEND_URL}/api/upload_image`, { method: 'POST', body: formData });
  return handleResponse(res);
};

export const uploadResource = async (formData) => {
  const res = await fetch(`${BACKEND_URL}/api/upload_resource`, { method: 'POST', body: formData });
  return handleResponse(res);
};

export const getTaskStatus = async (taskId) => {
  const res = await fetch(`${BACKEND_URL}/api/task/${taskId}`);
  return handleResponse(res);
};

export const resumeTask = async (taskId) => {
  const res = await fetch(`${BACKEND_URL}/api/task/${taskId}/resume`, { method: 'POST' });
  return handleResponse(res);
};

export const getAllTasks = async () => {
  const res = await fetch(`${BACKEND_URL}/api/tasks`);
  return handleResponse(res);
};

export const deleteTask = async (taskId) => {
  const res = await fetch(`${BACKEND_URL}/api/task/${taskId}`, { method: 'DELETE' });
  return handleResponse(res);
};

export const renameTask = async (taskId, name) => {
  const res = await fetch(`${BACKEND_URL}/api/task/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return handleResponse(res);
};

export const getImageUrl = (imagePath) => {
  if (!imagePath) return '';
  return `${BACKEND_URL}/api/image?path=${encodeURIComponent(imagePath)}`;
};

export const regenerateTaskPage = async (taskId, index) => {
  const res = await fetch(`${BACKEND_URL}/api/task/${taskId}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: index })
  });
  return handleResponse(res);
};

export const updateTaskPageParsedResult = async (taskId, index, parsedResult) => {
  const res = await fetch(`${BACKEND_URL}/api/task/${taskId}/page/${index}/parsed_result`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parsed_result: parsedResult }),
  });
  return handleResponse(res);
};

export const getVocabularyCategories = async () => {
  const res = await fetch(`${BACKEND_URL}/api/vocabulary/categories`);
  return handleResponse(res);
};

const requireVocabularyCategory = (category) => {
  const normalized = String(category || '').trim();
  if (!normalized) {
    throw new Error('保存目录不能为空，必须使用 data/文件夹/');
  }
  return normalized;
};

export const addVocabulary = async (word, context, source = '', fetchLlm = false, fetchType = 'all', category = '', focusPositions = []) => {
  const finalCategory = requireVocabularyCategory(category);
  const res = await fetch(`${BACKEND_URL}/api/vocabulary/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      word,
      context,
      source,
      fetch_llm: fetchLlm,
      fetch_type: fetchType,
      category: finalCategory,
      focus_positions: Array.isArray(focusPositions) ? focusPositions : [],
    })
  });
  return handleResponse(res);
};

export const getVocabularyList = async (category = '') => {
  const res = await fetch(`${BACKEND_URL}/api/vocabulary/list?category=${encodeURIComponent(category)}`);
  return handleResponse(res);
};

export const getVocabularyDetail = async (word, category = '') => {
  const res = await fetch(`${BACKEND_URL}/api/vocabulary/detail/${encodeURIComponent(word)}?category=${encodeURIComponent(category)}`);
  return handleResponse(res);
};
