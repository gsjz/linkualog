const envBackendUrl = String(import.meta.env.VITE_BACKEND_URL || '').trim()
const backendPort = String(import.meta.env.VITE_BACKEND_PORT || '').trim() || '8081'
const requestTimeoutMs = Number(import.meta.env.VITE_REQUEST_TIMEOUT_MS || 10000)
const host = window.location.hostname || 'localhost'
const protocol = window.location.protocol || 'http:'
const currentOrigin = window.location.origin || `${protocol}//${host}`
const devBackendUrl = `${protocol}//${host}:${backendPort}`
const appBasePath = String(import.meta.env.BASE_URL || '/').trim()
const normalizedBasePath = appBasePath && appBasePath !== '/'
  ? `/${appBasePath.replace(/^\/+|\/+$/g, '')}`
  : ''
const currentBackendUrl = `${currentOrigin}${normalizedBasePath}`
const BACKEND_URL = envBackendUrl || (import.meta.env.DEV ? devBackendUrl : currentBackendUrl)

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))

const readErrorMessage = async (res) => {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const payload = await res.json().catch(() => null)
    const detail = payload?.detail || payload?.message
    if (typeof detail === 'string' && detail.trim()) {
      return detail.trim()
    }
  }
  return (await res.text().catch(() => '')).trim()
}

const handleResponse = async (res) => {
  if (!res.ok) {
    const errorText = await readErrorMessage(res)
    const error = new Error(errorText ? `请求失败 (${res.status}): ${errorText}` : `请求失败 (${res.status})`)
    error.status = res.status
    throw error
  }
  return res.json()
}

const normalizeRequestError = (error) => {
  if (error?.name === 'AbortError') {
    return new Error(`请求超时（>${Math.round(requestTimeoutMs / 1000)}s），请重试。`)
  }
  if (error instanceof TypeError) {
    return new Error('网络连接失败，未能连接到 KnoTodo 服务。')
  }
  return error instanceof Error ? error : new Error('请求失败，请稍后重试。')
}

const isRetriableError = (error) => (
  error?.name === 'AbortError'
  || error instanceof TypeError
  || (typeof error?.status === 'number' && error.status >= 500)
)

const request = async (path, options = {}) => {
  const method = String(options?.method || 'GET').toUpperCase()
  const maxAttempts = method === 'GET' ? 2 : 1
  let lastError = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), requestTimeoutMs)

    try {
      const res = await fetch(`${BACKEND_URL}${path}`, {
        ...options,
        cache: method === 'GET' ? 'no-store' : options.cache,
        signal: controller.signal,
      })
      return await handleResponse(res)
    } catch (error) {
      lastError = normalizeRequestError(error)
      const shouldRetry = attempt < maxAttempts - 1 && isRetriableError(error)
      if (!shouldRetry) {
        throw lastError
      }
      await sleep(220 * (attempt + 1))
    } finally {
      window.clearTimeout(timeoutId)
    }
  }

  throw lastError || new Error('请求失败，请稍后重试。')
}

export const getDashboard = (month) => request(`/api/dashboard?month=${encodeURIComponent(month)}`)
export const getDayView = (day) => request(`/api/day/${encodeURIComponent(day)}`)
export const searchItems = (query, limit = 20) => request(`/api/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`)
export const getTemplates = () => request('/api/templates')
export const getBoards = () => request('/api/boards')
export const getBoardView = (boardId, day, options = {}) => {
  const params = new URLSearchParams()
  if (day) params.set('day', day)
  if (options.includeArchived) params.set('include_archived', 'true')
  const query = params.toString()
  return request(`/api/boards/${encodeURIComponent(boardId)}${query ? `?${query}` : ''}`)
}

export const createTemplate = (payload) => request('/api/templates', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const updateTemplate = (templateId, payload) => request(`/api/templates/${encodeURIComponent(templateId)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const deleteTemplate = (templateId) => request(`/api/templates/${encodeURIComponent(templateId)}`, {
  method: 'DELETE',
})

export const createTodo = (payload) => request('/api/todos', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const updateTodo = (todoId, payload) => request(`/api/todos/${encodeURIComponent(todoId)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const deleteTodo = (todoId) => request(`/api/todos/${encodeURIComponent(todoId)}`, {
  method: 'DELETE',
})

export const createEvent = (payload) => request('/api/events', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const updateEvent = (eventId, payload) => request(`/api/events/${encodeURIComponent(eventId)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const deleteEvent = (eventId) => request(`/api/events/${encodeURIComponent(eventId)}`, {
  method: 'DELETE',
})

export const createBoard = (payload) => request('/api/boards', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const updateBoard = (boardId, payload) => request(`/api/boards/${encodeURIComponent(boardId)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const deleteBoard = (boardId) => request(`/api/boards/${encodeURIComponent(boardId)}`, {
  method: 'DELETE',
})

export const createLane = (payload) => request('/api/lanes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const updateLane = (laneId, payload) => request(`/api/lanes/${encodeURIComponent(laneId)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const moveLane = (laneId, position) => request(`/api/lanes/${encodeURIComponent(laneId)}/move`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ position }),
})

export const deleteLane = (laneId) => request(`/api/lanes/${encodeURIComponent(laneId)}`, {
  method: 'DELETE',
})

export const setLaneCardsArchived = (laneId, archived = true) => request(`/api/lanes/${encodeURIComponent(laneId)}/archive`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ archived: Boolean(archived) }),
})

export const createCard = (payload) => request('/api/cards', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const updateCard = (cardId, payload) => request(`/api/cards/${encodeURIComponent(cardId)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const moveCard = (cardId, move) => request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    lane_id: move.laneId,
    position: typeof move.position === 'number' ? move.position : undefined,
    before_card_id: String(move.beforeCardId || '').trim() || undefined,
    after_card_id: String(move.afterCardId || '').trim() || undefined,
  }),
})

export const deleteCard = (cardId) => request(`/api/cards/${encodeURIComponent(cardId)}`, {
  method: 'DELETE',
})
