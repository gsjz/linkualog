const pad = (value) => String(value).padStart(2, '0')
const SUGGESTION_STEP_MINUTES = 30

export const DAY_START_MINUTES = 8 * 60
export const DAY_END_MINUTES = 21 * 60

export const parseTimeToMinutes = (value) => {
  const [hours, minutes] = String(value || '').split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return hours * 60 + minutes
}

export const addMinutesToTime = (value, minutesToAdd) => {
  const base = parseTimeToMinutes(value) ?? 9 * 60
  const total = ((base + minutesToAdd) % (24 * 60) + (24 * 60)) % (24 * 60)
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

export const getEventDurationMinutes = (item) => {
  const start = parseTimeToMinutes(item.start_time)
  const end = parseTimeToMinutes(item.end_time)
  if (start === null || end === null || end <= start) return 45
  return end - start
}

export const formatEventWindow = (item) => `${item.start_time || '--:--'} - ${item.end_time || '--:--'}`

const snapUpToStep = (minutes, step = SUGGESTION_STEP_MINUTES) => Math.ceil(minutes / step) * step
const snapDownToStep = (minutes, step = SUGGESTION_STEP_MINUTES) => Math.floor(minutes / step) * step
const priorityRank = {
  high: 0,
  medium: 1,
  low: 2,
}

export const findEventConflicts = (events, candidate, excludeId = '') => {
  const candidateStart = parseTimeToMinutes(candidate.start_time)
  const candidateEnd = parseTimeToMinutes(candidate.end_time)
  if (candidateStart === null || candidateEnd === null || candidateEnd <= candidateStart) return []

  return events.filter((item) => {
    if (excludeId && item.id === excludeId) return false
    if (item.date !== candidate.date) return false

    const start = parseTimeToMinutes(item.start_time)
    const end = parseTimeToMinutes(item.end_time)
    if (start === null || end === null || end <= start) return false
    if (candidateEnd <= start || candidateStart >= end) return false
    return true
  })
}

export const collectConflictedEventIds = (events) => {
  const sortedEvents = [...events]
    .filter((item) => parseTimeToMinutes(item.start_time) !== null && parseTimeToMinutes(item.end_time) !== null)
    .sort((left, right) => left.start_time.localeCompare(right.start_time))

  const conflictedIds = new Set()

  for (let index = 0; index < sortedEvents.length; index += 1) {
    const current = sortedEvents[index]
    const currentEnd = parseTimeToMinutes(current.end_time)
    for (let nextIndex = index + 1; nextIndex < sortedEvents.length; nextIndex += 1) {
      const next = sortedEvents[nextIndex]
      const nextStart = parseTimeToMinutes(next.start_time)
      if (currentEnd === null || nextStart === null || nextStart >= currentEnd) break
      conflictedIds.add(current.id)
      conflictedIds.add(next.id)
    }
  }

  return conflictedIds
}

export const getEventValidationMessage = (events, candidate, excludeId = '') => {
  if (!candidate.start_time && !candidate.end_time) return ''
  if (!candidate.start_time || !candidate.end_time) return '开始和结束时间必须同时填写。'

  const start = parseTimeToMinutes(candidate.start_time)
  const end = parseTimeToMinutes(candidate.end_time)
  if (start === null || end === null) return '时间格式无效。'
  if (end <= start) return '结束时间必须晚于开始时间。'

  const conflicts = findEventConflicts(events, candidate, excludeId)
  if (conflicts.length === 0) return ''

  const labels = conflicts.slice(0, 2).map((item) => `${item.title} (${formatEventWindow(item)})`)
  if (conflicts.length > 2) labels.push(`另外 ${conflicts.length - 2} 个时间块`)
  return `时间块冲突：与 ${labels.join('、')} 重叠。`
}

export const getOpenWindows = (events, options = {}) => {
  const dayStart = options.dayStart ?? DAY_START_MINUTES
  const dayEnd = options.dayEnd ?? DAY_END_MINUTES

  const timelineEvents = [...events]
    .map((item) => ({
      id: item.id,
      start: parseTimeToMinutes(item.start_time),
      end: parseTimeToMinutes(item.end_time),
    }))
    .filter((item) => item.start !== null && item.end !== null && item.end > item.start)
    .sort((left, right) => left.start - right.start)

  const windows = []
  let cursor = dayStart

  timelineEvents.forEach((item) => {
    const start = Math.max(dayStart, item.start)
    const end = Math.min(dayEnd, item.end)
    if (end <= dayStart || start >= dayEnd) return
    if (start > cursor) {
      windows.push({ start: cursor, end: start, durationMinutes: start - cursor })
    }
    cursor = Math.max(cursor, end)
  })

  if (cursor < dayEnd) {
    windows.push({ start: cursor, end: dayEnd, durationMinutes: dayEnd - cursor })
  }

  return windows
}

export const buildSuggestedSlots = (events, options = {}) => {
  const durationMinutes = Math.max(15, options.durationMinutes ?? 45)
  const preferredMinutes = parseTimeToMinutes(options.preferredTime)
  const limit = options.limit ?? 3
  const windows = getOpenWindows(events, options).filter((item) => item.durationMinutes >= durationMinutes)

  const candidates = windows.flatMap((window) => {
    const latestStart = window.end - durationMinutes
    const windowStart = snapUpToStep(window.start)
    const windowEnd = snapDownToStep(latestStart)
    const midpointStart = snapDownToStep(window.start + Math.max(0, (window.durationMinutes - durationMinutes) / 2))

    const rawStarts = [windowStart, midpointStart, windowEnd]

    if (preferredMinutes !== null) {
      const clamped = Math.min(Math.max(preferredMinutes, window.start), latestStart)
      const snappedPreferred = snapDownToStep(clamped)
      rawStarts.unshift(snappedPreferred < window.start ? windowStart : snappedPreferred)
    }

    return rawStarts
      .map((startMinutes) => Math.min(Math.max(startMinutes, windowStart), windowEnd))
      .filter((startMinutes) => Number.isFinite(startMinutes) && startMinutes >= window.start && startMinutes <= latestStart)
      .map((startMinutes) => ({
        startMinutes,
        endMinutes: startMinutes + durationMinutes,
        durationMinutes,
        distanceToPreferred: preferredMinutes === null ? startMinutes - window.start : Math.abs(startMinutes - preferredMinutes),
      }))
  }).filter((item) => item.startMinutes + durationMinutes <= DAY_END_MINUTES)

  const unique = new Map()
  candidates
    .sort((left, right) => {
      if (preferredMinutes === null && left.startMinutes !== right.startMinutes) {
        return left.startMinutes - right.startMinutes
      }
      if (left.distanceToPreferred !== right.distanceToPreferred) {
        return left.distanceToPreferred - right.distanceToPreferred
      }
      return left.startMinutes - right.startMinutes
    })
    .forEach((item) => {
      const key = `${item.startMinutes}-${item.endMinutes}`
      if (!unique.has(key)) {
        unique.set(key, item)
      }
    })

  return Array.from(unique.values())
    .slice(0, limit)
    .map((item) => ({
      start_time: `${pad(Math.floor(item.startMinutes / 60))}:${pad(item.startMinutes % 60)}`,
      end_time: `${pad(Math.floor(item.endMinutes / 60))}:${pad(item.endMinutes % 60)}`,
      durationMinutes: item.durationMinutes,
    }))
}

export const buildBatchSuggestedPlan = (todos, events, options = {}) => {
  const fallbackDurationMinutes = Math.max(15, options.durationMinutes ?? 45)
  const colorResolver = options.colorResolver || (() => 'slate')
  const durationResolver = options.durationResolver || (() => fallbackDurationMinutes)
  const orderedTodos = [...todos].sort((left, right) => {
    const leftRank = priorityRank[left.priority] ?? priorityRank.medium
    const rightRank = priorityRank[right.priority] ?? priorityRank.medium
    if (leftRank !== rightRank) return leftRank - rightRank

    const leftCreated = String(left.created_at || '')
    const rightCreated = String(right.created_at || '')
    if (leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated)

    return String(left.title || '').localeCompare(String(right.title || ''), 'zh-CN')
  })

  const workingEvents = [...events]
  const assignments = []
  const skipped = []

  orderedTodos.forEach((todo) => {
    const durationMinutes = Math.max(15, durationResolver(todo) ?? fallbackDurationMinutes)
    const slot = buildSuggestedSlots(workingEvents, {
      durationMinutes,
      preferredTime: todo.due_time,
      limit: 1,
    })[0]

    if (!slot) {
      skipped.push(todo)
      return
    }

    assignments.push({
      todo_id: todo.id,
      title: todo.title,
      date: todo.date,
      notes: todo.notes,
      color: colorResolver(todo),
      duration_minutes: durationMinutes,
      start_time: slot.start_time,
      end_time: slot.end_time,
    })

    workingEvents.push({
      id: `planned-${todo.id}`,
      date: todo.date,
      start_time: slot.start_time,
      end_time: slot.end_time,
    })
  })

  return { assignments, skipped }
}
