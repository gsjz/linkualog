const backendPort = import.meta.env.VITE_BACKEND_PORT || '8000';

const BACKEND_URL = `http://${window.location.hostname}:${backendPort}`;

console.log("当前连接的后端地址:", BACKEND_URL);

const handleResponse = async (res) => {
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`请求失败 (状态码: ${res.status}): ${errorText}`);
  }
  return res.json();
};

export const fetchConfig = async () => {
  const res = await fetch(`${BACKEND_URL}/api/config`);
  return handleResponse(res);
};

export const saveConfig = async (formData) => {
  const res = await fetch(`${BACKEND_URL}/api/config`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse(res);
};

export const uploadImage = async (formData) => {
  const res = await fetch(`${BACKEND_URL}/api/upload_image`, {
    method: 'POST',
    body: formData,
  });
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

export const getImageUrl = (imagePath) => {
  if (!imagePath) return '';
  return `${BACKEND_URL}/api/image?path=${encodeURIComponent(imagePath)}`;
};

export const regenerateTaskPage = async (taskId, index) => {
  const res = await fetch(`${BACKEND_URL}/api/task/${taskId}/regenerate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ index: index })
  });
  return handleResponse(res);
};