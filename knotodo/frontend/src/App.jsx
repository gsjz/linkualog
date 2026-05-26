import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import {
  createBoard,
  createCard,
  createLane,
  deleteBoard,
  deleteCard,
  deleteLane,
  getBoardView,
  getBoards,
  moveCard,
  moveLane,
  setLaneCardsArchived,
  updateBoard,
  updateCard,
  updateLane,
} from './api/client'
import { parseTimeToMinutes } from './utils/schedule'
import 'katex/dist/katex.min.css'

const COLOR_OPTIONS = [
  { value: 'slate', label: 'Slate' },
  { value: 'teal', label: 'Teal' },
  { value: 'gold', label: 'Gold' },
  { value: 'coral', label: 'Coral' },
]

const EVENT_TYPE_OPTIONS = [
  { value: 'none', label: 'No time' },
  { value: 'interval', label: 'Interval' },
  { value: 'recurring', label: 'Recurring' },
  { value: 'deadline', label: 'Deadline' },
]

const REPEAT_RULE_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'daily', label: 'Daily' },
]

const WEEKDAY_OPTIONS = [
  { value: 'mon', label: 'Mon' },
  { value: 'tue', label: 'Tue' },
  { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' },
  { value: 'fri', label: 'Fri' },
  { value: 'sat', label: 'Sat' },
  { value: 'sun', label: 'Sun' },
]

const CALENDAR_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DEFAULT_TIMELINE_HOUR_HEIGHT = 66
const DAY_MINUTES = 24 * 60
const DEADLINE_WINDOW_MINUTES = 30
const WEEKDAY_BY_JS_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const TIMELINE_DAY_HEADER_HEIGHT = 30
const TIMELINE_DAY_WINDOW = 19
const TIMELINE_DAY_SHIFT = 6
const TIMELINE_RESIZE_EDGE_PX = 8
const TIMELINE_RANGE_OPTIONS = [
  { value: 'workday', label: '工作时段', start_minutes: 7 * 60 },
  { value: 'fullday', label: '全天', start_minutes: 0 },
]

const monthDayFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
const monthLabelFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' })

const pad = (value) => String(value).padStart(2, '0')
const formatIso = (value) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
const formatMonthKey = (value) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}`
const formatClockMinutes = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
const addDaysToIso = (isoDay, offset) => {
  const value = new Date(`${isoDay}T12:00:00`)
  value.setDate(value.getDate() + offset)
  return formatIso(value)
}
const dayDistance = (fromDay, toDay) => {
  const from = new Date(`${fromDay}T12:00:00`)
  const to = new Date(`${toDay}T12:00:00`)
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}
const isSameIsoDay = (left, right) => String(left || '') === String(right || '')
const splitCsv = (value) => Array.from(new Set(String(value || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)))
const joinCsv = (items) => (Array.isArray(items) ? items.join(', ') : '')
const formatMinutesLabel = (minutes) => {
  const safeMinutes = Number(minutes)
  if (!Number.isFinite(safeMinutes)) return '--:--'
  if (safeMinutes >= DAY_MINUTES) return '24:00'
  const clamped = Math.max(0, safeMinutes)
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`
}

const normalizeMinutesInDay = (minutes) => (
  ((Number(minutes) || 0) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES
)

const resolveWrappedDurationMinutes = (startMinutes, endMinutes, fallback = 60) => {
  const start = Number.isFinite(startMinutes) ? normalizeMinutesInDay(startMinutes) : null
  const end = Number.isFinite(endMinutes) ? normalizeMinutesInDay(endMinutes) : null
  if (start === null || end === null) return Math.max(1, Math.min(Number(fallback) || 60, DAY_MINUTES - 1))
  if (start === end) return Math.max(1, Math.min(Number(fallback) || 60, DAY_MINUTES - 1))
  if (end > start) return end - start
  return DAY_MINUTES - start + end
}

const isInteractiveTextEntryTarget = (target) => {
  if (!(target instanceof HTMLElement)) return false
  const tagName = String(target.tagName || '').toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true
  if (target.isContentEditable) return true
  return Boolean(target.closest('[contenteditable="true"]'))
}

const resolveVisibleCardMoveTarget = ({ visibleLanes, laneId, cardId, direction }) => {
  const visibleLane = (visibleLanes || []).find((item) => item.id === laneId)
  const visibleCards = visibleLane?.cards || []
  const visibleIndex = visibleCards.findIndex((item) => item.id === cardId)
  if (visibleIndex < 0) return null

  if (direction < 0) {
    if (visibleIndex > 0) {
      return { beforeCardId: visibleCards[visibleIndex - 1].id }
    }
    return null
  }

  if (direction > 0) {
    if (visibleIndex >= 0 && visibleIndex < visibleCards.length - 1) {
      return { afterCardId: visibleCards[visibleIndex + 1].id }
    }
  }

  return null
}

const normalizeWeekdays = (value) => {
  const rawItems = Array.isArray(value) ? value : splitCsv(value)
  const normalized = []
  rawItems.forEach((item) => {
    const key = String(item || '').trim().toLowerCase()
    if (!key || normalized.includes(key)) return
    if (WEEKDAY_OPTIONS.some((option) => option.value === key)) {
      normalized.push(key)
    }
  })
  return normalized
}

const resolveEventTiming = (startTime, endTime) => {
  const startMinutes = parseTimeToMinutes(startTime)
  const endMinutes = parseTimeToMinutes(endTime)
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null
  return {
    start_minutes: startMinutes,
    end_minutes: endMinutes,
    spans_next_day: endMinutes < startMinutes,
  }
}

const resolveDeadlineTiming = (startTime, endTime) => {
  const parsedStart = parseTimeToMinutes(startTime)
  const parsedEnd = parseTimeToMinutes(endTime)
  if (parsedStart === null && parsedEnd === null) return null

  let endMinutes = parsedEnd
  if (endMinutes === null && parsedStart !== null) {
    endMinutes = parsedStart
  }
  if (endMinutes === null) return null

  let startMinutes = parsedStart
  if (startMinutes === null || startMinutes >= endMinutes) {
    startMinutes = Math.max(0, endMinutes - DEADLINE_WINDOW_MINUTES)
  }
  if (startMinutes === endMinutes) {
    if (endMinutes < DAY_MINUTES - 1) {
      endMinutes += 1
    } else {
      startMinutes = Math.max(0, endMinutes - 1)
    }
  }

  return {
    start_minutes: startMinutes,
    end_minutes: endMinutes,
    start_time: formatClockMinutes(startMinutes),
    end_time: formatClockMinutes(endMinutes),
  }
}

const buildTimelineLayout = (events) => {
  const prepared = events
    .map((item) => {
      const start = Number.isFinite(item.start_minutes) ? Number(item.start_minutes) : parseTimeToMinutes(item.start_time)
      const end = Number.isFinite(item.end_minutes) ? Number(item.end_minutes) : parseTimeToMinutes(item.end_time)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
      return { ...item, start_minutes: start, end_minutes: end, duration_minutes: end - start }
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.start_minutes !== right.start_minutes) return left.start_minutes - right.start_minutes
      if (left.end_minutes !== right.end_minutes) return left.end_minutes - right.end_minutes
      return String(left.title || '').localeCompare(String(right.title || ''), 'zh-CN')
    })

  if (prepared.length === 0) return []

  const groups = []
  let groupItems = []
  let activeEnds = []
  let maxParallel = 0

  prepared.forEach((eventItem) => {
    activeEnds = activeEnds.filter((end) => end > eventItem.start_minutes)
    if (activeEnds.length === 0 && groupItems.length > 0) {
      groups.push({ items: groupItems, max_parallel: Math.max(maxParallel, 1) })
      groupItems = []
      maxParallel = 0
    }
    groupItems.push(eventItem)
    activeEnds.push(eventItem.end_minutes)
    maxParallel = Math.max(maxParallel, activeEnds.length)
  })

  if (groupItems.length > 0) {
    groups.push({ items: groupItems, max_parallel: Math.max(maxParallel, 1) })
  }

  const layout = []
  groups.forEach((group) => {
    const activeColumns = []
    group.items.forEach((eventItem) => {
      for (let index = activeColumns.length - 1; index >= 0; index -= 1) {
        if (activeColumns[index].end <= eventItem.start_minutes) {
          activeColumns.splice(index, 1)
        }
      }
      const used = new Set(activeColumns.map((item) => item.column))
      let column = 0
      while (used.has(column)) column += 1
      activeColumns.push({ end: eventItem.end_minutes, column })
      layout.push({
        ...eventItem,
        column,
        total_columns: group.max_parallel,
      })
    })
  })

  return layout
}

const buildMonthCells = (monthKey) => {
  const anchor = new Date(`${monthKey}-01T12:00:00`)
  const gridStart = new Date(anchor)
  const dayOffset = (anchor.getDay() + 6) % 7
  gridStart.setDate(anchor.getDate() - dayOffset)

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart)
    day.setDate(gridStart.getDate() + index)
    return {
      iso: formatIso(day),
      date: day.getDate(),
      inMonth: day.getMonth() === anchor.getMonth(),
    }
  })
}

const shiftMonthKey = (monthKey, offset) => {
  const anchor = new Date(`${monthKey}-01T12:00:00`)
  anchor.setMonth(anchor.getMonth() + offset)
  return formatMonthKey(anchor)
}

const dayWeekKey = (isoDay) => {
  const value = new Date(`${isoDay}T12:00:00`)
  return WEEKDAY_BY_JS_DAY[value.getDay()]
}

const cardStartsOnDay = (card, isoDay) => {
  const eventType = String(card.event_type || 'none')
  if (eventType === 'none') return false
  if (eventType === 'interval' || eventType === 'deadline') {
    return String(card.date || '') === isoDay
  }
  if (eventType !== 'recurring') return false

  const anchor = String(card.date || '')
  const until = String(card.repeat_end_date || '')
  if (anchor && isoDay < anchor) return false
  if (until && isoDay > until) return false
  const repeatRule = String(card.repeat_rule || 'none')
  if (repeatRule === 'daily') return true
  if (repeatRule !== 'weekly') return false

  const weekdays = normalizeWeekdays(card.repeat_weekdays)
  if (weekdays.length > 0) {
    return weekdays.includes(dayWeekKey(isoDay))
  }
  if (anchor) {
    return dayWeekKey(anchor) === dayWeekKey(isoDay)
  }
  return false
}

const buildCardTimelineSegments = (card, isoDay) => {
  const eventType = String(card.event_type || 'none')
  if (eventType === 'none') return []

  const timing = eventType === 'deadline'
    ? resolveDeadlineTiming(card.start_time, card.end_time)
    : resolveEventTiming(card.start_time, card.end_time)
  if (!timing) return []

  const segments = []
  if (cardStartsOnDay(card, isoDay)) {
    segments.push({
      source_day: isoDay,
      start_minutes: timing.start_minutes,
      end_minutes: timing.spans_next_day ? DAY_MINUTES : timing.end_minutes,
      start_time: formatMinutesLabel(timing.start_minutes),
      end_time: timing.spans_next_day ? '24:00' : formatMinutesLabel(timing.end_minutes),
      from_previous_day: false,
    })
  }

  if (timing.spans_next_day) {
    const previousDay = addDaysToIso(isoDay, -1)
    if (cardStartsOnDay(card, previousDay)) {
      segments.push({
        source_day: previousDay,
        start_minutes: 0,
        end_minutes: timing.end_minutes,
        start_time: '00:00',
        end_time: formatMinutesLabel(timing.end_minutes),
        from_previous_day: true,
      })
    }
  }

  return segments
}

const cardAppearsOnDay = (card, isoDay) => buildCardTimelineSegments(card, isoDay).length > 0

const countTimedCardsOnDay = (cards, isoDay) => (
  cards.filter((card) => cardAppearsOnDay(card, isoDay)).length
)
const countDeadlineCardsOnDay = (cards, isoDay) => (
  cards.filter((card) => (
    String(card.event_type || 'none') === 'deadline'
    && cardAppearsOnDay(card, isoDay)
  )).length
)

const buildTimelineEventsForDay = (cards, lanesById, isoDay) => {
  const items = []
  cards.forEach((card) => {
    const segments = buildCardTimelineSegments(card, isoDay)
    if (segments.length === 0) return
    const lane = lanesById[String(card.lane_id || '')]
    segments.forEach((segment, segmentIndex) => {
      items.push({
        id: card.id,
        title: card.title,
        lane_id: card.lane_id,
        lane_title: lane?.title || '',
        color: card.color || 'slate',
        event_type: card.event_type || 'none',
        date: isoDay,
        occurrence_date: segment.source_day,
        continuation: segment.from_previous_day,
        segment_index: segmentIndex,
        start_time: segment.start_time,
        end_time: segment.end_time,
        start_minutes: segment.start_minutes,
        end_minutes: segment.end_minutes,
        labels: card.labels || [],
        members: card.members || [],
        due_date: card.due_date || '',
        repeat_rule: card.repeat_rule || 'none',
      })
    })
  })
  return buildTimelineLayout(items)
}

const resolveFocusMinutesForDay = (card, day, fallbackMinutes) => {
  const segments = buildCardTimelineSegments(card, day)
  if (segments.length === 0) return fallbackMinutes
  return Math.min(...segments.map((segment) => segment.start_minutes))
}

const findNearestRecurringDay = (card, selectedDay, fallbackDay) => {
  const anchorDay = String(card.date || '').trim()
  const untilDay = String(card.repeat_end_date || '').trim()
  const baseDay = String(selectedDay || anchorDay || fallbackDay || '').trim()
  if (!baseDay) return ''
  if (cardAppearsOnDay(card, baseDay)) return baseDay

  const withinRange = (day) => {
    if (anchorDay && day < anchorDay) return false
    if (untilDay && day > untilDay) return false
    return true
  }

  for (let offset = 1; offset <= 370; offset += 1) {
    const forward = addDaysToIso(baseDay, offset)
    if (withinRange(forward) && cardAppearsOnDay(card, forward)) {
      return forward
    }
    const backward = addDaysToIso(baseDay, -offset)
    if (withinRange(backward) && cardAppearsOnDay(card, backward)) {
      return backward
    }
    const reachedLower = anchorDay ? backward < anchorDay : false
    const reachedUpper = untilDay ? forward > untilDay : false
    if (reachedLower && reachedUpper) break
  }

  if (anchorDay && cardAppearsOnDay(card, anchorDay)) return anchorDay
  if (untilDay && cardAppearsOnDay(card, untilDay)) return untilDay
  return anchorDay || selectedDay || fallbackDay
}

const resolveCardFocus = (card, selectedDay, fallbackDay) => {
  if (!card) return { day: fallbackDay, minutes: 8 * 60 }
  const eventType = String(card.event_type || 'none')
  const cardDate = String(card.date || '').trim()
  const cardDue = String(card.due_date || '').trim()
  const startMinutes = parseTimeToMinutes(card.start_time)
  const endMinutes = parseTimeToMinutes(card.end_time)
  const fallbackMinutes = eventType === 'deadline'
    ? (endMinutes ?? startMinutes ?? 8 * 60)
    : (startMinutes ?? 8 * 60)

  if (eventType === 'interval') {
    if (cardAppearsOnDay(card, selectedDay)) {
      return { day: selectedDay, minutes: resolveFocusMinutesForDay(card, selectedDay, fallbackMinutes) }
    }
    if (cardDate) return { day: cardDate, minutes: resolveFocusMinutesForDay(card, cardDate, fallbackMinutes) }
  }
  if (eventType === 'deadline') {
    const deadlineTiming = resolveDeadlineTiming(card.start_time, card.end_time)
    const deadlineFocusMinutes = deadlineTiming
      ? Math.max(deadlineTiming.start_minutes, deadlineTiming.end_minutes - 10)
      : fallbackMinutes
    if (cardAppearsOnDay(card, selectedDay)) {
      return { day: selectedDay, minutes: deadlineFocusMinutes }
    }
    if (cardDate) return { day: cardDate, minutes: deadlineFocusMinutes }
  }
  if (eventType === 'recurring') {
    const focusDay = findNearestRecurringDay(card, selectedDay, fallbackDay)
    if (focusDay) return { day: focusDay, minutes: resolveFocusMinutesForDay(card, focusDay, fallbackMinutes) }
    if (cardDate) return { day: cardDate, minutes: resolveFocusMinutesForDay(card, cardDate, fallbackMinutes) }
  }
  if (cardDate) return { day: cardDate, minutes: resolveFocusMinutesForDay(card, cardDate, fallbackMinutes) }
  if (cardDue) return { day: cardDue, minutes: 12 * 60 }
  return { day: selectedDay || fallbackDay, minutes: 8 * 60 }
}

const toCardForm = (card, selectedDay) => {
  if (!card) {
    return {
      title: '',
      description: '',
      labels_text: '',
      members_text: '',
      due_date: '',
      color: 'slate',
      event_type: 'none',
      date: selectedDay,
      repeat_end_date: '',
      start_time: '09:00',
      end_time: '10:00',
      repeat_rule: 'weekly',
      repeat_weekdays: ['mon'],
      checklist: [],
      archived: false,
    }
  }
  const eventType = String(card.event_type || 'none')
  const endTime = String(card.end_time || '10:00')
  const deadlineTiming = resolveDeadlineTiming(card.start_time, endTime)
  return {
    title: String(card.title || ''),
    description: String(card.description || ''),
    labels_text: joinCsv(card.labels),
    members_text: joinCsv(card.members),
    due_date: String(card.due_date || ''),
    color: String(card.color || 'slate'),
    event_type: eventType,
    date: String(card.date || selectedDay || ''),
    repeat_end_date: String(card.repeat_end_date || ''),
    start_time: eventType === 'deadline'
      ? (deadlineTiming?.start_time || '09:00')
      : String(card.start_time || '09:00'),
    end_time: eventType === 'deadline'
      ? (deadlineTiming?.end_time || endTime)
      : endTime,
    repeat_rule: String(card.repeat_rule || 'weekly'),
    repeat_weekdays: normalizeWeekdays(card.repeat_weekdays),
    checklist: Array.isArray(card.checklist) ? card.checklist : [],
    archived: Boolean(card.archived),
  }
}

const validateCardForm = (form) => {
  if (!String(form.title || '').trim()) {
    return '卡片标题不能为空。'
  }

  const eventType = String(form.event_type || 'none')
  if (eventType === 'none') return ''

  if ((eventType === 'interval' || eventType === 'deadline') && !form.date) {
    return '区间和 Deadline 事件必须选择日期。'
  }

  if (eventType === 'deadline') {
    const deadlineTiming = resolveDeadlineTiming(form.start_time, form.end_time)
    if (!deadlineTiming) return 'Deadline 必须填写截止时间。'
    return ''
  }

  const start = parseTimeToMinutes(form.start_time)
  const end = parseTimeToMinutes(form.end_time)
  if (start === null || end === null) {
    return '开始和结束时间无效。'
  }
  if (start === end) return '开始和结束时间不能相同。'

  if (eventType === 'recurring') {
    if (!form.date) {
      return '周期事件必须设置起始日期。'
    }
    if (form.repeat_end_date && form.repeat_end_date < form.date) {
      return '周期中止日期不能早于起始日期。'
    }
    if (!['daily', 'weekly'].includes(form.repeat_rule)) {
      return '周期规则仅支持 daily / weekly。'
    }
    if (form.repeat_rule === 'weekly' && normalizeWeekdays(form.repeat_weekdays).length === 0) {
      return '每周周期必须至少选一个 weekday。'
    }
  }

  return ''
}

const buildCardPayload = (form) => {
  const eventType = String(form.event_type || 'none')
  const deadlineTiming = eventType === 'deadline'
    ? resolveDeadlineTiming(form.start_time, form.end_time)
    : null
  const payload = {
    title: String(form.title || '').trim(),
    description: String(form.description || '').trim(),
    labels: splitCsv(form.labels_text),
    members: splitCsv(form.members_text),
    due_date: String(form.due_date || '').trim(),
    color: String(form.color || 'slate'),
    event_type: eventType,
    date: String(form.date || '').trim(),
    repeat_end_date: String(form.repeat_end_date || '').trim(),
    start_time: eventType === 'deadline'
      ? String(deadlineTiming?.start_time || '').trim()
      : String(form.start_time || '').trim(),
    end_time: eventType === 'deadline'
      ? String(deadlineTiming?.end_time || '').trim()
      : String(form.end_time || '').trim(),
    repeat_rule: String(form.repeat_rule || 'weekly').trim().toLowerCase(),
    repeat_weekdays: normalizeWeekdays(form.repeat_weekdays),
    checklist: Array.isArray(form.checklist) ? form.checklist : [],
    archived: Boolean(form.archived),
  }
  if (eventType === 'none') {
    payload.date = ''
    payload.repeat_end_date = ''
    payload.start_time = ''
    payload.end_time = ''
    payload.repeat_rule = 'none'
    payload.repeat_weekdays = []
  }
  if (eventType === 'interval' || eventType === 'deadline') {
    payload.repeat_end_date = ''
    payload.repeat_rule = 'none'
    payload.repeat_weekdays = []
    if (eventType === 'deadline' && !payload.due_date && payload.date) {
      payload.due_date = payload.date
    }
  }
  return payload
}

const summarizeCardTime = (card) => {
  const eventType = String(card.event_type || 'none')
  if (eventType === 'none') return 'No time'
  if (eventType === 'deadline') {
    const timing = resolveDeadlineTiming(card.start_time, card.end_time)
    if (!timing) return 'Deadline --:--'
    return `Deadline ${timing.end_time}`
  }
  const timing = resolveEventTiming(card.start_time, card.end_time)
  const windowLabel = timing
    ? `${formatMinutesLabel(timing.start_minutes)}-${formatMinutesLabel(timing.end_minutes)}${timing.spans_next_day ? ' (+1d)' : ''}`
    : `${card.start_time || '--:--'}-${card.end_time || '--:--'}`
  if (eventType === 'recurring') {
    const start = String(card.date || '')
    const end = String(card.repeat_end_date || '')
    const range = start ? `${start}${end ? ` ~ ${end}` : ' ~ ∞'}` : 'No range'
    if (card.repeat_rule === 'daily') return `Daily ${windowLabel} · ${range}`
    return `Weekly ${windowLabel} · ${range}`
  }
  return windowLabel
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath]
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex]

const RichText = ({ value, className = '' }) => (
  <ReactMarkdown
    className={className}
    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
    components={{
      a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
    }}
  >
    {String(value || '')}
  </ReactMarkdown>
)

function App() {
  const today = useMemo(() => formatIso(new Date()), [])
  const [boards, setBoards] = useState([])
  const [activeBoardId, setActiveBoardId] = useState('')
  const [selectedDay, setSelectedDay] = useState(today)
  const [calendarMonth, setCalendarMonth] = useState(today.slice(0, 7))
  const [timelineStartDay, setTimelineStartDay] = useState(
    addDaysToIso(today, -Math.floor(TIMELINE_DAY_WINDOW / 2)),
  )
  const [includeArchived, setIncludeArchived] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [timedOnly, setTimedOnly] = useState(false)
  const [timelineRange, setTimelineRange] = useState('workday')
  const [timelineHourHeight, setTimelineHourHeight] = useState(DEFAULT_TIMELINE_HOUR_HEIGHT)
  const [boardView, setBoardView] = useState({ board: null, lanes: [], timeline_events: [], day: today })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [newBoardTitle, setNewBoardTitle] = useState('')
  const [newLaneTitle, setNewLaneTitle] = useState('')
  const [cardDrafts, setCardDrafts] = useState({})
  const [selectedCardId, setSelectedCardId] = useState('')
  const [selectedLaneId, setSelectedLaneId] = useState('')
  const [cardForm, setCardForm] = useState(toCardForm(null, today))
  const [timelineDraftPreview, setTimelineDraftPreview] = useState(null)
  const [boardForm, setBoardForm] = useState({ title: '', description: '', color: 'slate' })
  const [editingLaneId, setEditingLaneId] = useState('')
  const [editingLaneTitle, setEditingLaneTitle] = useState('')
  const [newChecklistText, setNewChecklistText] = useState('')
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false)
  const [isCardDetailOpen, setIsCardDetailOpen] = useState(false)
  const [isBoardEditorOpen, setIsBoardEditorOpen] = useState(false)
  const [nowTime, setNowTime] = useState(new Date())
  const laneStripRef = useRef(null)
  const timelineScrollRef = useRef(null)
  const timelineCanvasRef = useRef(null)
  const timelineResizeDragRef = useRef(null)
  const suppressTimelineClickRef = useRef(false)
  const suppressTimelineClickTimerRef = useRef(null)
  const cardItemRefs = useRef({})
  const pendingTimelineShiftRef = useRef(0)
  const pendingTimelineFocusRef = useRef(null)
  const isAdjustingTimelineRef = useRef(false)
  const hasInitializedTimelineRef = useRef(false)
  const lastFocusedCardIdRef = useRef('')
  const timelineShiftCooldownRef = useRef(0)
  const timelineSwitchAttemptRef = useRef({ id: '', day: '', count: 0, last_ts: 0 })

  const selectedDayLabel = useMemo(
    () => monthDayFormatter.format(new Date(`${selectedDay}T12:00:00`)),
    [selectedDay],
  )
  const calendarLabel = useMemo(
    () => monthLabelFormatter.format(new Date(`${calendarMonth}-01T12:00:00`)),
    [calendarMonth],
  )
  const timelineDays = useMemo(
    () => Array.from({ length: TIMELINE_DAY_WINDOW }, (_, index) => addDaysToIso(timelineStartDay, index)),
    [timelineStartDay],
  )
  const timelineEndDay = useMemo(
    () => timelineDays[timelineDays.length - 1] || timelineStartDay,
    [timelineDays, timelineStartDay],
  )
  const timelineDayHeight = useMemo(
    () => DAY_MINUTES * (timelineHourHeight / 60),
    [timelineHourHeight],
  )
  const timelineSectionHeight = useMemo(
    () => timelineDayHeight + TIMELINE_DAY_HEADER_HEIGHT,
    [timelineDayHeight],
  )
  const timelineTotalHeight = useMemo(
    () => timelineDays.length * timelineSectionHeight,
    [timelineDays, timelineSectionHeight],
  )
  const timelineRangeStart = useMemo(() => {
    const activeRange = TIMELINE_RANGE_OPTIONS.find((item) => item.value === timelineRange)
    return activeRange?.start_minutes ?? 0
  }, [timelineRange])
  const isTodaySelected = useMemo(() => isSameIsoDay(selectedDay, today), [selectedDay, today])

  const allCards = useMemo(() => (
    (boardView.lanes || []).flatMap((lane) => lane.cards || [])
  ), [boardView.lanes])
  const lanesById = useMemo(() => (
    Object.fromEntries((boardView.lanes || []).map((lane) => [lane.id, lane]))
  ), [boardView.lanes])
  const timelineEventsByDay = useMemo(() => {
    const lookup = {}
    timelineDays.forEach((day) => {
      lookup[day] = buildTimelineEventsForDay(allCards, lanesById, day)
    })
    return lookup
  }, [allCards, lanesById, timelineDays])
  const timelineLayout = useMemo(
    () => timelineEventsByDay[selectedDay] || [],
    [timelineEventsByDay, selectedDay],
  )
  const selectedCard = useMemo(
    () => allCards.find((item) => item.id === selectedCardId) || null,
    [allCards, selectedCardId],
  )
  const activeBoard = useMemo(
    () => boards.find((item) => item.id === activeBoardId) || boardView.board || null,
    [boards, activeBoardId, boardView.board],
  )
  const selectedTimelineEvent = useMemo(
    () => timelineLayout.find((item) => item.id === selectedCardId) || null,
    [timelineLayout, selectedCardId],
  )
  const getFirstEventMinutesOfDay = (day) => {
    const dayEvents = timelineEventsByDay[String(day || '')] || []
    if (dayEvents.length === 0) return null
    let earliest = DAY_MINUTES
    dayEvents.forEach((item) => {
      if (!Number.isFinite(item.start_minutes)) return
      earliest = Math.min(earliest, Number(item.start_minutes))
    })
    return earliest < DAY_MINUTES ? earliest : null
  }
  const resolveTimelineAnchorMinutes = (day, fallbackMinutes) => {
    const fallback = Math.max(0, Math.min(Number(fallbackMinutes) || 0, DAY_MINUTES - 30))
    if (timelineRange !== 'workday') return fallback
    const earliest = getFirstEventMinutesOfDay(day)
    if (earliest === null) return fallback
    return Math.max(0, Math.min(earliest, DAY_MINUTES - 30))
  }

  const filteredLanes = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    return (boardView.lanes || []).map((lane, index) => {
      const laneCards = lane.cards || []
      const cards = laneCards.filter((card) => {
        if (timedOnly && String(card.event_type || 'none') === 'none') {
          return false
        }
        if (!query) return true
        const searchable = [
          card.title || '',
          card.description || '',
          ...(card.labels || []),
          ...(card.members || []),
          card.due_date || '',
        ].join(' ').toLowerCase()
        return searchable.includes(query)
      })
      return {
        ...lane,
        lane_index: index,
        total_card_count: laneCards.length,
        cards,
      }
    })
  }, [boardView.lanes, searchText, timedOnly])

  const monthCells = useMemo(() => buildMonthCells(calendarMonth), [calendarMonth])
  const monthEventCount = useMemo(() => {
    const counts = {}
    monthCells.forEach((cell) => {
      if (cell.inMonth) {
        counts[cell.iso] = countTimedCardsOnDay(allCards, cell.iso)
      }
    })
    return counts
  }, [allCards, monthCells])
  const monthDeadlineCount = useMemo(() => {
    const counts = {}
    monthCells.forEach((cell) => {
      if (cell.inMonth) {
        counts[cell.iso] = countDeadlineCardsOnDay(allCards, cell.iso)
      }
    })
    return counts
  }, [allCards, monthCells])
  const selectedRecurringVisibleDays = useMemo(() => {
    const eventType = String(selectedCard?.event_type || 'none')
    if (!selectedCard || eventType !== 'recurring') return new Set()
    const highlighted = new Set()
    monthCells.forEach((cell) => {
      if (cardAppearsOnDay(selectedCard, cell.iso)) {
        highlighted.add(cell.iso)
      }
    })
    return highlighted
  }, [selectedCard, monthCells])

  const hasFilters = useMemo(
    () => Boolean(searchText.trim() || timedOnly),
    [searchText, timedOnly],
  )

  const loadBoardData = async (preferredBoardId = activeBoardId, preferredDay = selectedDay, options = {}) => {
    const silent = Boolean(options.silent)
    if (!silent) {
      setLoading(true)
    }
    try {
      const boardsPayload = await getBoards()
      const items = boardsPayload?.items || []
      setBoards(items)
      if (items.length === 0) {
        setActiveBoardId('')
        setBoardView({ board: null, lanes: [], timeline_events: [], day: preferredDay })
        return true
      }

      const targetBoardId = items.some((item) => item.id === preferredBoardId)
        ? preferredBoardId
        : items[0].id
      if (targetBoardId !== activeBoardId) {
        setActiveBoardId(targetBoardId)
      }

      const viewPayload = await getBoardView(targetBoardId, preferredDay, { includeArchived })
      setBoardView({
        board: viewPayload?.board || null,
        lanes: viewPayload?.lanes || [],
        timeline_events: viewPayload?.timeline_events || [],
        day: viewPayload?.day || preferredDay,
      })
      setSelectedDay(viewPayload?.day || preferredDay)
      setBoardForm({
        title: String(viewPayload?.board?.title || ''),
        description: String(viewPayload?.board?.description || ''),
        color: String(viewPayload?.board?.color || 'slate'),
      })
      setError('')
      return true
    } catch (requestError) {
      setError(requestError?.message || '加载失败')
      return false
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }

  const runMutation = async (mutation, options = {}) => {
    const boardId = options.boardId ?? activeBoardId
    const day = options.day ?? selectedDay
    const successMessage = options.successMessage || ''
    setSaving(true)
    setError('')
    try {
      const result = await mutation()
      await loadBoardData(boardId, day, { silent: true })
      if (successMessage) setNotice(successMessage)
      return result
    } catch (requestError) {
      setError(requestError?.message || '操作失败')
      return null
    } finally {
      setSaving(false)
    }
  }

  const scrollTimelineToDay = (day, minutes = 8 * 60, behavior = 'auto') => {
    if (!day) return
    const safeMinutes = Math.max(0, Math.min(Number(minutes) || 0, DAY_MINUTES - 30))
    const innerStart = addDaysToIso(timelineStartDay, 1)
    const innerEnd = addDaysToIso(timelineEndDay, -1)
    if (day < innerStart || day > innerEnd) {
      pendingTimelineFocusRef.current = { day, minutes: safeMinutes, behavior }
      setTimelineStartDay(addDaysToIso(day, -Math.floor(TIMELINE_DAY_WINDOW / 2)))
      return
    }

    const node = timelineScrollRef.current
    if (!node) return
    const dayIndex = dayDistance(timelineStartDay, day)
    const top = (
      dayIndex * timelineSectionHeight
      + TIMELINE_DAY_HEADER_HEIGHT
      + (safeMinutes * timelineHourHeight) / 60
      - 96
    )
    node.scrollTo({ top: Math.max(0, top), behavior })
  }

  const shiftTimelineWindow = (offsetDays) => {
    if (!offsetDays) return
    if (isAdjustingTimelineRef.current) return
    isAdjustingTimelineRef.current = true
    pendingTimelineShiftRef.current -= offsetDays * timelineSectionHeight
    setTimelineStartDay((current) => addDaysToIso(current, offsetDays))
  }

  const handleTimelineScroll = (event) => {
    if (isAdjustingTimelineRef.current) return
    const nowTick = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (nowTick < timelineShiftCooldownRef.current) return
    const node = event.currentTarget
    const centerY = node.scrollTop + node.clientHeight * 0.35
    const dayIndex = Math.max(0, Math.min(
      timelineDays.length - 1,
      Math.floor(centerY / timelineSectionHeight),
    ))
    const day = timelineDays[dayIndex]
    if (day && !isSameIsoDay(day, selectedDay)) {
      setSelectedDay(day)
      setCalendarMonth(day.slice(0, 7))
    }
  }

  useEffect(() => {
    void loadBoardData(activeBoardId, selectedDay)
  }, [])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const timer = window.setInterval(() => setNowTime(new Date()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!selectedCard) return
    if (isCardDetailOpen && timelineDraftPreview?.card_id === selectedCard.id) return
    setCardForm(toCardForm(selectedCard, selectedDay))
  }, [selectedCard, selectedDay, isCardDetailOpen, timelineDraftPreview?.card_id])

  useEffect(() => {
    if (!selectedCardId) return
    if (!selectedCard) {
      setSelectedCardId('')
      setCardForm(toCardForm(null, selectedDay))
    }
  }, [selectedCard, selectedCardId, selectedDay])

  useEffect(() => {
    if (selectedCard) return
    setIsCardDetailOpen(false)
  }, [selectedCard])

  useEffect(() => {
    if (!isCardDetailOpen || !selectedCardId) {
      setTimelineDraftPreview(null)
    }
  }, [isCardDetailOpen, selectedCardId])

  useEffect(() => {
    timelineSwitchAttemptRef.current = { id: '', day: '', count: 0, last_ts: 0 }
  }, [selectedCardId, isCardDetailOpen])

  useEffect(() => {
    if (cardForm.event_type === 'none') {
      setTimelineDraftPreview(null)
    }
  }, [cardForm.event_type])

  useEffect(() => {
    const lanes = boardView.lanes || []
    if (lanes.length === 0) {
      if (selectedLaneId) setSelectedLaneId('')
      return
    }
    if (selectedCard?.lane_id) {
      if (selectedLaneId !== selectedCard.lane_id) {
        setSelectedLaneId(selectedCard.lane_id)
      }
      return
    }
    if (!selectedLaneId || !lanes.some((lane) => lane.id === selectedLaneId)) {
      setSelectedLaneId(lanes[0].id)
    }
  }, [boardView.lanes, selectedCard, selectedLaneId])

  useEffect(() => () => {
    const active = timelineResizeDragRef.current
    if (active?.move_handler) {
      window.removeEventListener('mousemove', active.move_handler)
    }
    if (active?.up_handler) {
      window.removeEventListener('mouseup', active.up_handler)
    }
    timelineResizeDragRef.current = null
    if (suppressTimelineClickTimerRef.current) {
      window.clearTimeout(suppressTimelineClickTimerRef.current)
      suppressTimelineClickTimerRef.current = null
    }
    document.body.classList.remove('knt-resizing-timeline')
  }, [])

  useEffect(() => {
    if (activeBoardId) return
    setIsBoardEditorOpen(false)
  }, [activeBoardId])

  useEffect(() => {
    setCalendarMonth(selectedDay.slice(0, 7))
  }, [selectedDay])

  useEffect(() => {
    if (!activeBoardId) return
    void loadBoardData(activeBoardId, selectedDay)
  }, [includeArchived])

  useEffect(() => {
    if (!selectedCardId) {
      lastFocusedCardIdRef.current = ''
      return
    }
    if (!selectedCard) return
    if (lastFocusedCardIdRef.current === selectedCard.id) return
    lastFocusedCardIdRef.current = selectedCard.id
    if (String(selectedCard.event_type || 'none') === 'none') return

    const focus = resolveCardFocus(selectedCard, selectedDay, today)
    setSelectedDay(focus.day)
    setCalendarMonth(focus.day.slice(0, 7))
    scrollTimelineToDay(focus.day, Math.max(focus.minutes, timelineRangeStart), 'auto')
  }, [selectedCardId, selectedCard, selectedDay, timelineRangeStart, today])

  useLayoutEffect(() => {
    const node = timelineScrollRef.current
    if (!node) return

    if (pendingTimelineShiftRef.current !== 0) {
      node.scrollTop += pendingTimelineShiftRef.current
      pendingTimelineShiftRef.current = 0
      timelineShiftCooldownRef.current = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 140
    }
    if (pendingTimelineFocusRef.current) {
      const { day, minutes, behavior } = pendingTimelineFocusRef.current
      const dayIndex = dayDistance(timelineStartDay, day)
      const anchorMinutes = resolveTimelineAnchorMinutes(day, minutes)
      const top = (
        dayIndex * timelineSectionHeight
        + TIMELINE_DAY_HEADER_HEIGHT
        + (anchorMinutes * timelineHourHeight) / 60
        - 96
      )
      node.scrollTo({ top: Math.max(0, top), behavior: behavior || 'auto' })
      pendingTimelineFocusRef.current = null
    } else if (!hasInitializedTimelineRef.current) {
      const baseMinutes = selectedTimelineEvent
        ? Math.max(selectedTimelineEvent.start_minutes, timelineRangeStart)
        : (isTodaySelected ? nowTime.getHours() * 60 + nowTime.getMinutes() : timelineRangeStart)
      const initialMinutes = resolveTimelineAnchorMinutes(selectedDay, baseMinutes)
      const dayIndex = dayDistance(timelineStartDay, selectedDay)
      const top = (
        dayIndex * timelineSectionHeight
        + TIMELINE_DAY_HEADER_HEIGHT
        + (initialMinutes * timelineHourHeight) / 60
        - 96
      )
      node.scrollTop = Math.max(0, top)
      hasInitializedTimelineRef.current = true
    }
    isAdjustingTimelineRef.current = false
  }, [
    timelineStartDay,
    selectedDay,
    selectedTimelineEvent,
    timelineRangeStart,
    timelineSectionHeight,
    timelineHourHeight,
    isTodaySelected,
    nowTime,
  ])

  useEffect(() => {
    if (!selectedDay) return
    if (isAdjustingTimelineRef.current) return
    const nowTick = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (nowTick < timelineShiftCooldownRef.current) return
    const dayIndex = dayDistance(timelineStartDay, selectedDay)
    if (!Number.isFinite(dayIndex)) return
    if (dayIndex <= 2) {
      timelineShiftCooldownRef.current = nowTick + 140
      shiftTimelineWindow(-TIMELINE_DAY_SHIFT)
      return
    }
    if (dayIndex >= timelineDays.length - 3) {
      timelineShiftCooldownRef.current = nowTick + 140
      shiftTimelineWindow(TIMELINE_DAY_SHIFT)
    }
  }, [selectedDay, timelineStartDay, timelineDays.length])

  useEffect(() => {
    if (!selectedCardId) return
    const cardNode = cardItemRefs.current[selectedCardId]
    if (!cardNode) return
    cardNode.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [selectedCardId, filteredLanes])

  useEffect(() => {
    const handleGlobalArrowShortcut = (event) => {
      if (event.defaultPrevented) return
      if (event.repeat) return
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      if (isInteractiveTextEntryTarget(event.target)) return
      if (saving) return

      const lanes = boardView.lanes || []

      if (selectedCard && !selectedCard.archived) {
        const laneIndex = lanes.findIndex((lane) => lane.id === selectedCard.lane_id)
        if (laneIndex < 0) return
        const currentLane = lanes[laneIndex]
        const cards = currentLane?.cards || []
        const cardIndex = cards.findIndex((item) => item.id === selectedCard.id)
        if (cardIndex < 0) return

        event.preventDefault()
        if (event.key === 'ArrowLeft' && laneIndex > 0) {
          const targetLane = lanes[laneIndex - 1]
          if (targetLane) {
            const targetVisibleLane = filteredLanes.find((lane) => lane.id === targetLane.id)
            const targetVisibleCards = targetVisibleLane?.cards || []
            void handleMoveCard(selectedCard.id, targetVisibleCards.length > 0
              ? { laneId: targetLane.id, afterCardId: targetVisibleCards[targetVisibleCards.length - 1].id }
              : { laneId: targetLane.id, position: 0 })
          }
          return
        }
        if (event.key === 'ArrowRight' && laneIndex < lanes.length - 1) {
          const targetLane = lanes[laneIndex + 1]
          if (targetLane) {
            const targetVisibleLane = filteredLanes.find((lane) => lane.id === targetLane.id)
            const targetVisibleCards = targetVisibleLane?.cards || []
            void handleMoveCard(selectedCard.id, targetVisibleCards.length > 0
              ? { laneId: targetLane.id, afterCardId: targetVisibleCards[targetVisibleCards.length - 1].id }
              : { laneId: targetLane.id, position: 0 })
          }
          return
        }
        if (event.key === 'ArrowUp') {
          const moveTarget = resolveVisibleCardMoveTarget({
            visibleLanes: filteredLanes,
            laneId: currentLane.id,
            cardId: selectedCard.id,
            direction: -1,
          })
          if (moveTarget) {
            void handleMoveCard(selectedCard.id, { laneId: currentLane.id, ...moveTarget })
          }
          return
        }
        if (event.key === 'ArrowDown') {
          const moveTarget = resolveVisibleCardMoveTarget({
            visibleLanes: filteredLanes,
            laneId: currentLane.id,
            cardId: selectedCard.id,
            direction: 1,
          })
          if (moveTarget) {
            void handleMoveCard(selectedCard.id, { laneId: currentLane.id, ...moveTarget })
          }
        }
        return
      }

      const selectedLaneIndex = lanes.findIndex((lane) => lane.id === selectedLaneId)
      if (selectedLaneIndex < 0) return
      const currentLane = lanes[selectedLaneIndex]
      if (!currentLane) return

      event.preventDefault()
      if (event.key === 'ArrowLeft' && selectedLaneIndex > 0) {
        void handleMoveLane(currentLane, -1)
        return
      }
      if (event.key === 'ArrowRight' && selectedLaneIndex < lanes.length - 1) {
        void handleMoveLane(currentLane, 1)
        return
      }
      if (event.key === 'ArrowUp' && selectedLaneIndex > 0) {
        setSelectedLaneId(lanes[selectedLaneIndex - 1].id)
        return
      }
      if (event.key === 'ArrowDown' && selectedLaneIndex < lanes.length - 1) {
        setSelectedLaneId(lanes[selectedLaneIndex + 1].id)
      }
    }

    window.addEventListener('keydown', handleGlobalArrowShortcut)
    return () => window.removeEventListener('keydown', handleGlobalArrowShortcut)
  }, [boardView.lanes, filteredLanes, saving, selectedCard, selectedLaneId])

  const handleSwitchBoard = async (boardId) => {
    setActiveBoardId(boardId)
    setSelectedCardId('')
    setSelectedLaneId('')
    await loadBoardData(boardId, selectedDay)
  }

  const handleCreateBoard = async () => {
    const title = String(newBoardTitle || '').trim()
    if (!title) return
    const created = await runMutation(
      () => createBoard({ title, color: 'slate', description: '' }),
      { successMessage: 'Board 已创建' },
    )
    setNewBoardTitle('')
    const createdId = created?.item?.id
    if (createdId) {
      setActiveBoardId(createdId)
      await loadBoardData(createdId, selectedDay)
    }
  }

  const handleSaveBoard = async () => {
    if (!activeBoardId) return
    const title = String(boardForm.title || '').trim()
    if (!title) {
      setError('看板标题不能为空。')
      return
    }
    await runMutation(
      () => updateBoard(activeBoardId, {
        title,
        description: boardForm.description || '',
        color: boardForm.color || 'slate',
      }),
      { successMessage: 'Board 已更新' },
    )
  }

  const handleDeleteBoard = async () => {
    if (!activeBoardId) return
    const nextBoards = boards.filter((item) => item.id !== activeBoardId)
    const nextBoardId = nextBoards[0]?.id || ''
    const deleted = await runMutation(
      () => deleteBoard(activeBoardId),
      { boardId: nextBoardId, successMessage: 'Board 已删除' },
    )
    if (!deleted) return
    setSelectedCardId('')
    setSelectedLaneId('')
    setActiveBoardId(nextBoardId)
    if (nextBoardId) {
      await loadBoardData(nextBoardId, selectedDay)
    } else {
      await loadBoardData('', selectedDay)
    }
  }

  const handleCreateLane = async () => {
    const title = String(newLaneTitle || '').trim()
    if (!activeBoardId || !title) return
    await runMutation(
      () => createLane({ board_id: activeBoardId, title }),
      { successMessage: 'List 已创建' },
    )
    setNewLaneTitle('')
  }

  const handleStartLaneRename = (lane) => {
    setEditingLaneId(lane.id)
    setEditingLaneTitle(lane.title)
  }

  const handleSubmitLaneRename = async (lane) => {
    const title = String(editingLaneTitle || '').trim()
    if (!title || title === lane.title) {
      setEditingLaneId('')
      setEditingLaneTitle('')
      return
    }
    const updated = await runMutation(
      () => updateLane(lane.id, { title }),
      { successMessage: 'List 已更新' },
    )
    if (updated) {
      setEditingLaneId('')
      setEditingLaneTitle('')
    }
  }

  const handleMoveLane = async (lane, offset) => {
    const lanes = boardView.lanes || []
    const index = lanes.findIndex((item) => item.id === lane.id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= lanes.length) return
    await runMutation(
      () => moveLane(lane.id, target),
      { successMessage: 'List 已移动' },
    )
  }

  const handleDeleteLane = async (laneId) => {
    await runMutation(
      () => deleteLane(laneId),
      { successMessage: 'List 已删除' },
    )
  }

  const handleAddCard = async (laneId) => {
    const title = String(cardDrafts[laneId] || '').trim()
    if (!activeBoardId || !title) return
    await runMutation(
      () => createCard({
        board_id: activeBoardId,
        lane_id: laneId,
        title,
        event_type: 'none',
      }),
      { successMessage: 'Card 已创建' },
    )
    setCardDrafts((current) => ({ ...current, [laneId]: '' }))
  }

  const handleSelectLane = (laneId) => {
    if (!laneId) return
    setSelectedLaneId(laneId)
    if (selectedCardId) {
      setSelectedCardId('')
      setIsCardDetailOpen(false)
      setCardForm(toCardForm(null, selectedDay))
    }
  }

  const openCardDetail = (cardId) => {
    if (!cardId) return
    const linkedCard = allCards.find((item) => item.id === cardId)
    if (linkedCard?.lane_id) {
      setSelectedLaneId(linkedCard.lane_id)
    }
    setSelectedCardId(cardId)
    setIsCardDetailOpen(true)
  }

  const handleMoveCard = async (cardId, move) => {
    await runMutation(
      () => moveCard(cardId, move),
      { successMessage: 'Card 已移动' },
    )
  }

  const handleSetCardArchived = async (cardId, archived) => {
    const updated = await runMutation(
      () => updateCard(cardId, { archived }),
      { successMessage: archived ? 'Card 已归档' : 'Card 已恢复' },
    )
    if (updated && archived && !includeArchived && cardId === selectedCardId) {
      setSelectedCardId('')
      setCardForm(toCardForm(null, selectedDay))
      setTimelineDraftPreview(null)
    }
  }

  const handleSetLaneArchived = async (lane, archived) => {
    const sourceLane = (boardView.lanes || []).find((item) => item.id === lane.id)
    const cardsInLane = sourceLane?.cards || []
    const hasTargetCards = archived
      ? cardsInLane.some((item) => !item.archived)
      : cardsInLane.some((item) => item.archived)
    if (!hasTargetCards) return

    const confirmed = window.confirm(
      archived
        ? `Archive list "${lane.title}" 的全部卡片？`
        : `Restore list "${lane.title}" 中全部已归档卡片？`,
    )
    if (!confirmed) return

    const result = await runMutation(
      () => setLaneCardsArchived(lane.id, archived),
      { successMessage: archived ? 'List 卡片已归档' : 'List 卡片已恢复' },
    )
    if (!result) return

    if (archived && !includeArchived && selectedCard && selectedCard.lane_id === lane.id) {
      setSelectedCardId('')
      setIsCardDetailOpen(false)
      setCardForm(toCardForm(null, selectedDay))
    }
  }

  const handleSaveCard = async () => {
    if (!selectedCardId) return
    const validationMessage = validateCardForm(cardForm)
    if (validationMessage) {
      setError(validationMessage)
      return
    }
    const payload = buildCardPayload(cardForm)
    const saved = await runMutation(
      () => updateCard(selectedCardId, payload),
      { successMessage: 'Card 已保存' },
    )
    if (saved) {
      setTimelineDraftPreview(null)
    }
  }

  const handleDeleteCard = async () => {
    if (!selectedCardId) return
    const currentId = selectedCardId
    const deleted = await runMutation(
      () => deleteCard(currentId),
      { successMessage: 'Card 已删除' },
    )
    if (deleted) {
      setSelectedCardId('')
      setCardForm(toCardForm(null, selectedDay))
      setTimelineDraftPreview(null)
    }
  }

  const handleToggleChecklistItem = (itemId, checked) => {
    setCardForm((current) => ({
      ...current,
      checklist: (current.checklist || []).map((item) => (
        item.id === itemId ? { ...item, done: checked } : item
      )),
    }))
  }

  const handleUpdateChecklistText = (itemId, text) => {
    setCardForm((current) => ({
      ...current,
      checklist: (current.checklist || []).map((item) => (
        item.id === itemId ? { ...item, text } : item
      )),
    }))
  }

  const handleDeleteChecklistItem = (itemId) => {
    setCardForm((current) => ({
      ...current,
      checklist: (current.checklist || []).filter((item) => item.id !== itemId),
    }))
  }

  const handleAddChecklistItem = () => {
    const value = String(newChecklistText || '').trim()
    if (!value) return
    setCardForm((current) => ({
      ...current,
      checklist: [
        ...(current.checklist || []),
        { id: `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`, text: value, done: false },
      ],
    }))
    setNewChecklistText('')
  }

  const attemptSwitchTimelineEvent = (item, day) => {
    if (!isCardDetailOpen || !selectedCardId) return false
    if (!item?.id || item.id === selectedCardId) return false

    const now = Date.now()
    const previous = timelineSwitchAttemptRef.current
    const sameTarget = (
      previous.id === item.id
      && previous.day === day
      && now - previous.last_ts <= 900
    )
    const nextCount = sameTarget ? previous.count + 1 : 1
    timelineSwitchAttemptRef.current = { id: item.id, day, count: nextCount, last_ts: now }

    if (nextCount >= 3) {
      timelineSwitchAttemptRef.current = { id: '', day: '', count: 0, last_ts: 0 }
      if (item.lane_id) setSelectedLaneId(item.lane_id)
      setSelectedDay(day)
      setCalendarMonth(day.slice(0, 7))
      setTimelineDraftPreview(null)
      openCardDetail(item.id)
      setNotice('已切换到目标事件。')
      return true
    }

    setNotice(`继续点击同一事件 ${3 - nextCount} 次可切换。`)
    return false
  }

  const applyTimelineSelectionAtPointer = (clientY, options = {}) => {
    if (!selectedCardId) return false
    if (!isCardDetailOpen) return false
    if (cardForm.event_type === 'none') return false
    const canvasNode = timelineCanvasRef.current
    if (!canvasNode) return false

    const rect = canvasNode.getBoundingClientRect()
    const totalHeight = timelineDays.length * timelineSectionHeight
    const offsetY = Math.max(0, Math.min(clientY - rect.top, totalHeight))
    const pointerDayIndex = Math.max(0, Math.min(
      timelineDays.length - 1,
      Math.floor(offsetY / timelineSectionHeight),
    ))
    const lockedDay = String(options.lockDay || '').trim()
    const lockedDayIndex = lockedDay
      ? Math.max(0, Math.min(timelineDays.length - 1, dayDistance(timelineStartDay, lockedDay)))
      : null
    const activeDayIndex = lockedDayIndex === null ? pointerDayIndex : lockedDayIndex
    const targetDay = timelineDays[activeDayIndex] || selectedDay
    const rawInDayY = offsetY - activeDayIndex * timelineSectionHeight - TIMELINE_DAY_HEADER_HEIGHT
    if (!lockedDay && rawInDayY < 0) {
      setSelectedDay(targetDay)
      setCalendarMonth(targetDay.slice(0, 7))
      return true
    }
    const inDayY = Math.max(0, Math.min(
      rawInDayY,
      DAY_MINUTES * (timelineHourHeight / 60),
    ))
    const stepMinutes = Math.max(1, Math.min(60, Math.round(Number(options.stepMinutes) || 30)))
    const shouldNotify = !options.silentNotice
    const minutes = Math.round((inDayY / (timelineHourHeight / 60)) / stepMinutes) * stepMinutes
    const clamped = Math.max(0, Math.min(minutes, DAY_MINUTES - 1))

    if (cardForm.event_type === 'deadline') {
      const currentStart = parseTimeToMinutes(cardForm.start_time)
      const currentEnd = parseTimeToMinutes(cardForm.end_time)
      const currentDuration = (
        Number.isFinite(currentStart)
        && Number.isFinite(currentEnd)
        && currentEnd > currentStart
      )
        ? currentEnd - currentStart
        : DEADLINE_WINDOW_MINUTES
      const deadlineDuration = Math.max(1, Math.min(currentDuration, DAY_MINUTES - 1))
      const previewStartMinutes = Math.max(0, Math.min(clamped, DAY_MINUTES - 1 - deadlineDuration))
      const previewEndMinutes = previewStartMinutes + deadlineDuration
      const startText = formatClockMinutes(previewStartMinutes)
      const endText = formatClockMinutes(previewEndMinutes)
      setCardForm((current) => ({
        ...current,
        start_time: startText,
        end_time: endText,
        date: targetDay,
        due_date: current.due_date || targetDay,
      }))
      setTimelineDraftPreview({
        card_id: selectedCardId,
        day: targetDay,
        event_type: 'deadline',
        title: String(cardForm.title || selectedCard?.title || 'Untitled'),
        color: String(cardForm.color || selectedCard?.color || 'slate'),
        start_minutes: previewStartMinutes,
        end_minutes: previewEndMinutes,
        start_time: startText,
        end_time: endText,
      })
      setSelectedDay(targetDay)
      setCalendarMonth(targetDay.slice(0, 7))
      if (shouldNotify) {
        setNotice('已从时间轴移动 Deadline 显示块，保存卡片后生效。')
      }
      return true
    }

    const adjustStartOnly = Boolean(options.adjustStart && !options.adjustEnd)
    const adjustEndOnly = Boolean(options.adjustEnd && !options.adjustStart)
    const currentStart = parseTimeToMinutes(cardForm.start_time)
    const currentEnd = parseTimeToMinutes(cardForm.end_time)
    const safeCurrentStart = Number.isFinite(currentStart) ? normalizeMinutesInDay(currentStart) : 9 * 60
    const safeCurrentEnd = Number.isFinite(currentEnd)
      ? normalizeMinutesInDay(currentEnd)
      : normalizeMinutesInDay(safeCurrentStart + 60)
    const isWrappedEvent = Number.isFinite(currentStart) && Number.isFinite(currentEnd) && currentEnd <= currentStart
    const duration = resolveWrappedDurationMinutes(safeCurrentStart, safeCurrentEnd, 60)

    let nextStart = clamped
    let nextEnd = normalizeMinutesInDay(nextStart + duration)
    let previewDuration = duration
    let noticeText = '已从时间轴移动开始时间（时长保持不变），保存卡片后生效。'

    if (adjustStartOnly) {
      if (isWrappedEvent) {
        nextStart = clamped
        nextEnd = safeCurrentEnd
        if (nextStart === nextEnd) {
          nextStart = normalizeMinutesInDay(nextEnd - 1)
        }
        previewDuration = resolveWrappedDurationMinutes(nextStart, nextEnd, 1)
      } else {
        const anchorEnd = Math.max(1, Math.min(safeCurrentEnd, DAY_MINUTES - 1))
        nextEnd = anchorEnd
        nextStart = Math.max(0, Math.min(clamped, anchorEnd - 1))
        previewDuration = Math.max(1, nextEnd - nextStart)
      }
      noticeText = '已从时间轴调整开始时间，保存卡片后生效。'
    } else if (adjustEndOnly) {
      if (isWrappedEvent) {
        nextStart = safeCurrentStart
        nextEnd = clamped
        if (nextStart === nextEnd) {
          nextEnd = normalizeMinutesInDay(nextStart + 1)
        }
        previewDuration = resolveWrappedDurationMinutes(nextStart, nextEnd, 1)
      } else {
        const anchorStart = Math.max(0, Math.min(safeCurrentStart, DAY_MINUTES - 2))
        nextStart = anchorStart
        nextEnd = Math.max(nextStart + 1, Math.min(clamped, DAY_MINUTES - 1))
        previewDuration = Math.max(1, nextEnd - nextStart)
      }
      noticeText = '已从时间轴调整结束时间，保存卡片后生效。'
    }

    const nextDate = cardForm.event_type === 'recurring' ? (cardForm.date || targetDay) : targetDay
    const startText = formatClockMinutes(nextStart)
    const endText = formatClockMinutes(nextEnd)

    setCardForm((current) => ({
      ...current,
      start_time: startText,
      end_time: endText,
      date: nextDate,
    }))
    setTimelineDraftPreview({
      card_id: selectedCardId,
      day: targetDay,
      event_type: cardForm.event_type,
      title: String(cardForm.title || selectedCard?.title || 'Untitled'),
      color: String(cardForm.color || selectedCard?.color || 'slate'),
      start_minutes: nextStart,
      end_minutes: nextStart + previewDuration,
      start_time: startText,
      end_time: endText,
    })
    setSelectedDay(targetDay)
    setCalendarMonth(targetDay.slice(0, 7))
    if (shouldNotify) {
      setNotice(noticeText)
    }
    return true
  }

  const suppressNextTimelineClick = () => {
    suppressTimelineClickRef.current = true
    if (suppressTimelineClickTimerRef.current) {
      window.clearTimeout(suppressTimelineClickTimerRef.current)
    }
    suppressTimelineClickTimerRef.current = window.setTimeout(() => {
      suppressTimelineClickRef.current = false
      suppressTimelineClickTimerRef.current = null
    }, 120)
  }

  const consumeSuppressedTimelineClick = () => {
    if (!suppressTimelineClickRef.current) return false
    suppressTimelineClickRef.current = false
    if (suppressTimelineClickTimerRef.current) {
      window.clearTimeout(suppressTimelineClickTimerRef.current)
      suppressTimelineClickTimerRef.current = null
    }
    return true
  }

  const handleTimelineClick = (event) => {
    if (consumeSuppressedTimelineClick()) return
    applyTimelineSelectionAtPointer(event.clientY)
  }

  const resolveTimelineResizeEdge = (event, item, isDeadline = false) => {
    if (!isCardDetailOpen || !selectedCardId) return ''
    if (!item?.id || item.id !== selectedCardId) return ''
    if (String(cardForm.event_type || 'none') === 'none') return ''

    const rect = event.currentTarget.getBoundingClientRect()
    const offsetY = event.clientY - rect.top
    if (isDeadline) return ''
    const edgeSize = Math.min(TIMELINE_RESIZE_EDGE_PX, Math.max(4, rect.height / 3))
    if (offsetY >= 0 && offsetY <= edgeSize) return 'start'
    if (offsetY <= rect.height && rect.height - offsetY <= edgeSize) return 'end'
    return ''
  }

  const updateTimelineEventResizeCursor = (event, item, isDeadline = false) => {
    const edge = resolveTimelineResizeEdge(event, item, isDeadline)
    event.currentTarget.classList.toggle('is-resize-start', edge === 'start')
    event.currentTarget.classList.toggle('is-resize-end', edge === 'end')
    event.currentTarget.style.cursor = edge ? 'ns-resize' : ''
  }

  const clearTimelineEventResizeCursor = (event) => {
    event.currentTarget.classList.remove('is-resize-start', 'is-resize-end')
    event.currentTarget.style.cursor = ''
  }

  const getActiveTimelineEditBlock = () => {
    if (!isCardDetailOpen || !selectedCardId) return null
    if (String(cardForm.event_type || 'none') === 'none') return null

    if (timelineDraftPreview?.card_id === selectedCardId) {
      const draftDay = String(timelineDraftPreview.day || '')
      const dayIndex = dayDistance(timelineStartDay, draftDay)
      if (dayIndex >= 0 && dayIndex < timelineDays.length) {
        const startMinutes = Math.max(0, Math.min(
          Number(timelineDraftPreview.start_minutes) || 0,
          DAY_MINUTES - 1,
        ))
        const endMinutes = Math.max(
          startMinutes + 1,
          Math.min(Number(timelineDraftPreview.end_minutes) || (startMinutes + 1), DAY_MINUTES),
        )
        const isDeadline = String(timelineDraftPreview.event_type || 'none') === 'deadline'
        const startY = dayIndex * timelineSectionHeight + TIMELINE_DAY_HEADER_HEIGHT + startMinutes * (timelineHourHeight / 60)
        const endY = dayIndex * timelineSectionHeight + TIMELINE_DAY_HEADER_HEIGHT + endMinutes * (timelineHourHeight / 60)
        return {
          day: draftDay,
          item: {
            id: selectedCardId,
            lane_id: selectedCard?.lane_id || '',
            title: timelineDraftPreview.title || selectedCard?.title || '',
            event_type: timelineDraftPreview.event_type || cardForm.event_type,
          },
          is_deadline: isDeadline,
          top: isDeadline ? endY : startY,
          bottom: endY,
          deadline_y: endY,
        }
      }
    }

    const preferredDay = (timelineEventsByDay[selectedDay] || []).find((item) => item.id === selectedCardId)
      ? selectedDay
      : timelineDays.find((day) => (timelineEventsByDay[day] || []).some((item) => item.id === selectedCardId))
    if (!preferredDay) return null
    const dayIndex = dayDistance(timelineStartDay, preferredDay)
    if (dayIndex < 0 || dayIndex >= timelineDays.length) return null
    const item = (timelineEventsByDay[preferredDay] || []).find((eventItem) => eventItem.id === selectedCardId)
    if (!item) return null
    const isDeadline = String(item.event_type || 'none') === 'deadline'
    const startY = dayIndex * timelineSectionHeight + TIMELINE_DAY_HEADER_HEIGHT + item.start_minutes * (timelineHourHeight / 60)
    const endY = dayIndex * timelineSectionHeight + TIMELINE_DAY_HEADER_HEIGHT + item.end_minutes * (timelineHourHeight / 60)
    return {
      day: preferredDay,
      item,
      is_deadline: isDeadline,
      top: isDeadline ? endY : startY,
      bottom: endY,
      deadline_y: endY,
    }
  }

  const resolveTimelineCanvasResizeTarget = (clientY) => {
    const canvasNode = timelineCanvasRef.current
    if (!canvasNode) return null
    const block = getActiveTimelineEditBlock()
    if (!block) return null

    const rect = canvasNode.getBoundingClientRect()
    const offsetY = clientY - rect.top
    const insideEdgeSize = Math.max(TIMELINE_RESIZE_EDGE_PX, 10)
    const startOutsideEdgeSize = 8
    const endOutsideEdgeSize = 1
    if (block.is_deadline) {
      return null
    }
    if (
      !block.is_deadline
      && offsetY >= block.top - startOutsideEdgeSize
      && offsetY <= block.top + insideEdgeSize
    ) {
      return { ...block, edge: 'start' }
    }
    if (
      offsetY >= block.bottom - insideEdgeSize
      && offsetY <= block.bottom + endOutsideEdgeSize
    ) {
      return { ...block, edge: 'end' }
    }
    return null
  }

  const updateTimelineCanvasResizeCursor = (event) => {
    const target = resolveTimelineCanvasResizeTarget(event.clientY)
    event.currentTarget.classList.toggle('is-resize-start', target?.edge === 'start')
    event.currentTarget.classList.toggle('is-resize-end', target?.edge === 'end')
  }

  const clearTimelineCanvasResizeCursor = (event) => {
    event.currentTarget.classList.remove('is-resize-start', 'is-resize-end')
  }

  const handleTimelineCanvasMouseDown = (event) => {
    if (event.button !== 0) return
    const target = resolveTimelineCanvasResizeTarget(event.clientY)
    if (!target) return
    clearTimelineCanvasResizeCursor(event)
    startTimelineResizeDrag(event, target.edge, target.item, target.day)
  }

  const stopTimelineResizeDrag = (noticeText = '') => {
    const active = timelineResizeDragRef.current
    const hadActiveDrag = Boolean(active)
    if (active?.move_handler) {
      window.removeEventListener('mousemove', active.move_handler)
    }
    if (active?.up_handler) {
      window.removeEventListener('mouseup', active.up_handler)
    }
    timelineResizeDragRef.current = null
    document.body.classList.remove('knt-resizing-timeline')
    if (noticeText) {
      setNotice(noticeText)
    }
    if (hadActiveDrag) {
      suppressNextTimelineClick()
    }
  }

  const startTimelineResizeDrag = (event, edge, item, day) => {
    if (!isCardDetailOpen || !selectedCardId) return
    if (!item?.id || item.id !== selectedCardId) return
    if (cardForm.event_type === 'none') return
    if (cardForm.event_type === 'deadline') return

    event.preventDefault()
    event.stopPropagation()

    stopTimelineResizeDrag()
    if (item.lane_id) setSelectedLaneId(item.lane_id)
    setSelectedDay(day)
    setCalendarMonth(day.slice(0, 7))

    applyTimelineSelectionAtPointer(event.clientY, {
      adjustStart: edge === 'start',
      adjustEnd: edge === 'end',
      stepMinutes: 5,
      silentNotice: true,
      lockDay: day,
    })

    const moveHandler = (moveEvent) => {
      moveEvent.preventDefault()
      applyTimelineSelectionAtPointer(moveEvent.clientY, {
        adjustStart: edge === 'start',
        adjustEnd: edge === 'end',
        stepMinutes: 5,
        silentNotice: true,
        lockDay: day,
      })
    }
    const upHandler = () => {
      stopTimelineResizeDrag(edge === 'start'
        ? '已拖拽调整开始时间，保存卡片后生效。'
        : '已拖拽调整结束时间，保存卡片后生效。')
    }

    timelineResizeDragRef.current = {
      edge,
      move_handler: moveHandler,
      up_handler: upHandler,
    }
    document.body.classList.add('knt-resizing-timeline')
    window.addEventListener('mousemove', moveHandler)
    window.addEventListener('mouseup', upHandler)
  }

  const handleJumpTimeline = (day, minutes) => {
    setSelectedDay(day)
    setCalendarMonth(day.slice(0, 7))
    scrollTimelineToDay(day, minutes, 'auto')
  }

  const handleJumpNow = () => {
    const now = new Date()
    setSelectedDay(today)
    setCalendarMonth(today.slice(0, 7))
    scrollTimelineToDay(today, now.getHours() * 60 + now.getMinutes(), 'auto')
  }

  const handlePickDay = (day) => {
    setSelectedDay(day)
    setCalendarMonth(day.slice(0, 7))
    const selectedEventOnDay = (timelineEventsByDay[day] || []).find((item) => item.id === selectedCardId) || null
    const baseAnchorMinutes = selectedEventOnDay
      ? Math.max(selectedEventOnDay.start_minutes, timelineRangeStart)
      : timelineRangeStart
    const anchorMinutes = resolveTimelineAnchorMinutes(day, baseAnchorMinutes)
    scrollTimelineToDay(day, anchorMinutes, 'auto')
  }

  const isCardDetailVisible = Boolean(selectedCard && isCardDetailOpen)

  return (
    <div className="knt-app">
      <section className="knt-layout knt-layout--three">
        <aside className={`knt-leftbar${isCardDetailVisible ? ' is-detail-open' : ''}`}>
          <section className="knt-panel">
            <header className="knt-panel-head">
              <h2>Boards</h2>
              <span>{boards.length}</span>
            </header>
            <div className="knt-board-list">
              {boards.map((board) => (
                <button
                  key={board.id}
                  type="button"
                  className={`knt-board-item${activeBoardId === board.id ? ' is-active' : ''}`}
                  onClick={() => { void handleSwitchBoard(board.id) }}
                >
                  <strong>{board.title}</strong>
                  <small>{board.card_count} cards</small>
                </button>
              ))}
            </div>
            <div className="knt-form-row">
              <label htmlFor="new-board-title">Create Board</label>
              <div className="knt-inline-actions knt-inline-actions--stretch">
                <input
                  id="new-board-title"
                  value={newBoardTitle}
                  onChange={(event) => setNewBoardTitle(event.target.value)}
                  placeholder="New board title"
                />
                <button type="button" className="knt-btn" disabled={saving || !newBoardTitle.trim()} onClick={() => { void handleCreateBoard() }}>
                  Add
                </button>
              </div>
            </div>
          </section>

          <section className="knt-panel">
            <header className="knt-panel-head">
              <h2>Filter</h2>
            </header>
            <div className="knt-form-row">
              <label htmlFor="board-search">Search</label>
              <input
                id="board-search"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search cards"
              />
            </div>
            <label className="knt-check">
              <input
                type="checkbox"
                checked={timedOnly}
                onChange={(event) => setTimedOnly(event.target.checked)}
              />
              Timed only
            </label>
            <label className="knt-check">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              Include archived
            </label>
          </section>

          <section className="knt-panel knt-board-overview">
            <header className="knt-panel-head">
              <h2>{activeBoard?.title || 'No Board'}</h2>
              <div className="knt-inline-actions">
                <button
                  type="button"
                  className="knt-btn knt-btn--tiny"
                  disabled={!activeBoardId}
                  onClick={() => setIsBoardEditorOpen(true)}
                >
                  Edit Board
                </button>
              </div>
            </header>
            <div className="knt-board-overview-desc">
              <RichText value={activeBoard?.description || '_无看板描述_'} className="knt-richtext" />
            </div>
            {boardView.board ? (
              <div className="knt-chip-row">
                <span className="knt-chip">Lanes {boardView.board.lane_count}</span>
                <span className="knt-chip">Cards {boardView.board.card_count}</span>
                <span className="knt-chip">Timed {boardView.board.timed_card_count}</span>
                <span className="knt-chip">Checklist {boardView.board.checklist_done}/{boardView.board.checklist_total}</span>
              </div>
            ) : null}
            <p className="knt-hint">双击卡片或时间轴事件可直接打开详情编辑。</p>
          </section>

          <section className="knt-panel">
            <header className="knt-panel-head">
              <h2>Event Rules</h2>
            </header>
            <p className="knt-hint">1. 区间事件：`Event Date + Start + End`；若 End 早于 Start，自动按跨天处理。</p>
            <p className="knt-hint">2. 周期事件点击后，会优先跳到离当前日期最近的一次 occurrence（同距离优先未来）。</p>
            <p className="knt-hint">3. Deadline：只需 `Event Date + Deadline Time`，开始时间自动回推用于时间轴显示。</p>
            <p className="knt-hint">4. `No time` 卡片仅选中，不会触发 Calendar / Timeline 自动跳转。</p>
          </section>

          <section className="knt-panel knt-shortcuts-panel">
            <header className="knt-panel-head">
              <h2>Shortcuts</h2>
              <button
                type="button"
                className="knt-btn knt-btn--tiny"
                onClick={() => setIsShortcutHelpOpen((current) => !current)}
              >
                {isShortcutHelpOpen ? 'Hide' : 'Show'}
              </button>
            </header>
            {isShortcutHelpOpen ? (
              <div className="knt-shortcuts-list">
                <p><kbd>Alt</kbd> + <kbd>←</kbd>/<kbd>→</kbd>: 选中 Card 时跨 Lane 移动；选中 Lane 时移动 Lane。</p>
                <p><kbd>Alt</kbd> + <kbd>↑</kbd>/<kbd>↓</kbd>: 选中 Card 时上下换位；选中 Lane 时切换上一/下一 Lane。</p>
                <p>单击 Lane 空白区会选中 Lane（不会选中 Card）。</p>
              </div>
            ) : (
              <p className="knt-hint">点击 `Show` 查看快捷键说明。</p>
            )}
          </section>
        </aside>

        <main className={`knt-main${isCardDetailVisible ? ' is-detail-open' : ''}`}>
          <section className="knt-lane-strip" ref={laneStripRef}>
            {filteredLanes.map((lane) => {
              const sourceLane = (boardView.lanes || []).find((item) => item.id === lane.id)
              const laneHasActiveCards = (sourceLane?.cards || []).some((item) => !item.archived)
              const laneHasArchivedCards = (sourceLane?.cards || []).some((item) => item.archived)
              const laneHasSelectedCard = (lane.cards || []).some((item) => item.id === selectedCardId)
              const laneIsSoloSelected = !laneHasSelectedCard && lane.id === selectedLaneId
              const laneIsSelected = laneHasSelectedCard || laneIsSoloSelected
              return (
                <article
                  key={lane.id}
                  className={`knt-lane${laneIsSelected ? ' is-selected-lane' : ''}${laneIsSoloSelected ? ' is-selected-lane-only' : ''}`}
                  onClick={(event) => {
                    if (!(event.target instanceof Element)) return
                    if (event.target.closest('.knt-card')) return
                    if (event.target.closest('button, input, textarea, select, a, label')) return
                    handleSelectLane(lane.id)
                  }}
                >
                  <header className="knt-lane-head">
                    {editingLaneId === lane.id ? (
                      <div className="knt-lane-title-edit">
                        <input
                          value={editingLaneTitle}
                          onChange={(event) => setEditingLaneTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void handleSubmitLaneRename(lane)
                            }
                            if (event.key === 'Escape') {
                              setEditingLaneId('')
                              setEditingLaneTitle('')
                            }
                          }}
                        />
                        <button type="button" className="knt-btn knt-btn--tiny" onClick={() => { void handleSubmitLaneRename(lane) }}>
                          Save
                        </button>
                      </div>
                    ) : (
                      <strong>{lane.title}</strong>
                    )}
                    <span>
                      {lane.cards.length}
                      {hasFilters ? ` / ${lane.total_card_count}` : ''}
                      {' '}cards
                    </span>
                  </header>

                  <div className="knt-inline-actions">
                    {editingLaneId === lane.id ? (
                      <button
                        type="button"
                        className="knt-btn knt-btn--tiny"
                        onClick={() => {
                          setEditingLaneId('')
                          setEditingLaneTitle('')
                        }}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button type="button" className="knt-btn knt-btn--tiny" onClick={() => handleStartLaneRename(lane)}>
                        Rename
                      </button>
                    )}
                    <button type="button" className="knt-btn knt-btn--tiny is-danger" onClick={() => { void handleDeleteLane(lane.id) }}>
                      Delete
                    </button>
                    <button
                      type="button"
                      className="knt-btn knt-btn--tiny"
                      disabled={!laneHasActiveCards}
                      onClick={() => { void handleSetLaneArchived(lane, true) }}
                    >
                      Archive All
                    </button>
                    <button
                      type="button"
                      className="knt-btn knt-btn--tiny"
                      disabled={!includeArchived || !laneHasArchivedCards}
                      onClick={() => { void handleSetLaneArchived(lane, false) }}
                    >
                      Restore All
                    </button>
                  </div>

                  <div className="knt-card-list">
                    {(lane.cards || []).map((card) => (
                      <article
                        key={card.id}
                        className={`knt-card tone-${card.color || 'slate'}${selectedCardId === card.id ? ' is-selected' : ''}${card.archived ? ' is-archived' : ''}`}
                        ref={(node) => {
                          if (node) {
                            cardItemRefs.current[card.id] = node
                          } else {
                            delete cardItemRefs.current[card.id]
                          }
                        }}
                        onClick={() => {
                          setSelectedCardId(card.id)
                          setSelectedLaneId(lane.id)
                        }}
                        onDoubleClick={() => openCardDetail(card.id)}
                      >
                        <header className="knt-card-head">
                          <strong>{card.title}</strong>
                          <span className="knt-tag">{String(card.event_type || 'none')}</span>
                        </header>
                        {card.labels?.length ? (
                          <div className="knt-chip-row">
                            {card.labels.map((label) => (
                              <span key={label} className="knt-chip">{label}</span>
                            ))}
                          </div>
                        ) : null}
                        <div className="knt-card-description">
                          <RichText value={card.description || '_无描述_'} className="knt-richtext knt-richtext--compact" />
                        </div>
                        <footer className="knt-card-foot">
                          <span>{summarizeCardTime(card)}</span>
                          <span>{card.due_date || 'No due'}</span>
                        </footer>
                        <footer className="knt-card-foot">
                          <span>Checklist {card.checklist_done || 0}/{card.checklist_total || 0}</span>
                          {card.archived ? <span>Archived</span> : <span>Active</span>}
                        </footer>
                        <div className="knt-inline-actions">
                          <button
                            type="button"
                            className="knt-btn knt-btn--tiny"
                            onClick={(event) => {
                              event.stopPropagation()
                              openCardDetail(card.id)
                            }}
                          >
                            Detail
                          </button>
                          <button
                            type="button"
                            className="knt-btn knt-btn--tiny"
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleSetCardArchived(card.id, !card.archived)
                            }}
                          >
                            {card.archived ? 'Restore' : 'Archive'}
                          </button>
                        </div>
                      </article>
                    ))}
                    {lane.cards.length === 0 ? (
                      <p className="knt-empty">当前筛选条件下没有卡片。</p>
                    ) : null}
                  </div>

                  <div className="knt-lane-new-card">
                    <input
                      value={cardDrafts[lane.id] || ''}
                      onChange={(event) => setCardDrafts((current) => ({ ...current, [lane.id]: event.target.value }))}
                      placeholder="New card title"
                    />
                    <button type="button" className="knt-btn knt-btn--tiny" disabled={saving || !String(cardDrafts[lane.id] || '').trim()} onClick={() => { void handleAddCard(lane.id) }}>
                      Add
                    </button>
                  </div>
                </article>
              )
            })}

            <article className="knt-lane knt-lane--new">
              <header className="knt-lane-head">
                <strong>Add List</strong>
              </header>
              <input
                value={newLaneTitle}
                onChange={(event) => setNewLaneTitle(event.target.value)}
                placeholder="List title"
              />
              <button type="button" className="knt-btn" disabled={saving || !newLaneTitle.trim() || !activeBoardId} onClick={() => { void handleCreateLane() }}>
                Create List
              </button>
            </article>
          </section>
          {isCardDetailVisible ? (
            <div className="knt-main-detail-overlay">
              <section className="knt-detail-modal knt-detail-modal--main">
                <header className="knt-detail-modal-head">
                  <h2>Card Detail</h2>
                  <div className="knt-detail-modal-head-actions">
                    <button type="button" className="knt-btn knt-btn--tiny knt-btn--primary" disabled={saving} onClick={() => { void handleSaveCard() }}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="knt-btn knt-btn--tiny"
                      disabled={saving}
                      onClick={() => { void handleSetCardArchived(selectedCard.id, !Boolean(selectedCard.archived)) }}
                    >
                      {selectedCard.archived ? 'Restore' : 'Archive'}
                    </button>
                    <button type="button" className="knt-btn knt-btn--tiny is-danger" disabled={saving} onClick={() => { void handleDeleteCard() }}>
                      Delete
                    </button>
                  </div>
                  <button type="button" className="knt-modal-close" onClick={() => setIsCardDetailOpen(false)}>
                    ×
                  </button>
                </header>
                <div className="knt-editor">
                  <div className="knt-form-row">
                    <label htmlFor="modal-card-title">Title</label>
                    <input
                      id="modal-card-title"
                      value={cardForm.title}
                      onChange={(event) => setCardForm((current) => ({ ...current, title: event.target.value }))}
                    />
                  </div>
                  <div className="knt-form-row">
                    <label htmlFor="modal-card-description">Description</label>
                    <textarea
                      id="modal-card-description"
                      rows={3}
                      value={cardForm.description}
                      onChange={(event) => setCardForm((current) => ({ ...current, description: event.target.value }))}
                    />
                    <small className="knt-hint">支持 Markdown 与 LaTeX（行内 `$...$`，块级 `$$...$$`）。</small>
                  </div>
                  <div className="knt-form-row">
                    <label>Preview</label>
                    <div className="knt-markdown-preview">
                      <RichText value={cardForm.description || '_无描述_'} className="knt-richtext" />
                    </div>
                  </div>
                  <div className="knt-form-grid">
                    <div className="knt-form-row">
                      <label htmlFor="modal-card-labels">Labels (comma)</label>
                      <input
                        id="modal-card-labels"
                        value={cardForm.labels_text}
                        onChange={(event) => setCardForm((current) => ({ ...current, labels_text: event.target.value }))}
                      />
                    </div>
                    <div className="knt-form-row">
                      <label htmlFor="modal-card-members">Members (comma)</label>
                      <input
                        id="modal-card-members"
                        value={cardForm.members_text}
                        onChange={(event) => setCardForm((current) => ({ ...current, members_text: event.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="knt-form-grid">
                    <div className="knt-form-row">
                      <label htmlFor="modal-card-color">Color</label>
                      <select
                        id="modal-card-color"
                        value={cardForm.color}
                        onChange={(event) => setCardForm((current) => ({ ...current, color: event.target.value }))}
                      >
                        {COLOR_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="knt-form-row">
                      <label htmlFor="modal-card-due">Due Date (Task)</label>
                      <input
                        id="modal-card-due"
                        type="date"
                        value={cardForm.due_date}
                        onChange={(event) => setCardForm((current) => ({ ...current, due_date: event.target.value }))}
                      />
                      <small className="knt-hint">仅用于任务截止信息，不决定时间轴出现场景。</small>
                    </div>
                  </div>
                  <div className="knt-form-grid">
                    <div className="knt-form-row">
                      <label htmlFor="modal-card-type">Time Type</label>
                      <select
                        id="modal-card-type"
                        value={cardForm.event_type}
                        onChange={(event) => {
                          const nextType = event.target.value
                          setCardForm((current) => {
                            const next = { ...current, event_type: nextType }
                            if (nextType === 'deadline') {
                              const seedEnd = String(current.end_time || current.start_time || '18:00').trim() || '18:00'
                              const deadlineTiming = resolveDeadlineTiming(current.start_time, seedEnd)
                              next.end_time = deadlineTiming?.end_time || seedEnd
                              next.start_time = deadlineTiming?.start_time || current.start_time
                              if (!next.date) next.date = selectedDay
                              if (!next.due_date && next.date) next.due_date = next.date
                            }
                            if ((nextType === 'interval' || nextType === 'recurring') && !next.date) {
                              next.date = selectedDay
                            }
                            return next
                          })
                        }}
                      >
                        {EVENT_TYPE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    {cardForm.event_type === 'recurring' ? (
                      <div className="knt-form-row">
                        <label htmlFor="modal-card-date">Start Date</label>
                        <input
                          id="modal-card-date"
                          type="date"
                          value={cardForm.date}
                          onChange={(event) => setCardForm((current) => ({ ...current, date: event.target.value }))}
                        />
                      </div>
                    ) : null}
                    {(cardForm.event_type === 'interval' || cardForm.event_type === 'deadline') ? (
                      <div className="knt-form-row">
                        <label htmlFor="modal-card-date">Event Date</label>
                        <input
                          id="modal-card-date"
                          type="date"
                          value={cardForm.date}
                          onChange={(event) => setCardForm((current) => ({ ...current, date: event.target.value }))}
                        />
                      </div>
                    ) : null}
                  </div>
                  {cardForm.event_type === 'recurring' ? (
                    <div className="knt-form-row">
                      <label htmlFor="modal-card-repeat-end-date">End Date (Optional)</label>
                      <input
                        id="modal-card-repeat-end-date"
                        type="date"
                        value={cardForm.repeat_end_date}
                        onChange={(event) => setCardForm((current) => ({ ...current, repeat_end_date: event.target.value }))}
                      />
                      <small className="knt-hint">留空表示长期有效；设置后只在起止区间内按规则出现。</small>
                    </div>
                  ) : null}
                  {cardForm.event_type === 'deadline' ? (
                    <div className="knt-form-grid">
                      <div className="knt-form-row">
                        <label htmlFor="modal-card-end">Deadline Time</label>
                        <input
                          id="modal-card-end"
                          type="time"
                          value={cardForm.end_time}
                          onChange={(event) => setCardForm((current) => {
                            const deadlineTiming = resolveDeadlineTiming(current.start_time, event.target.value)
                            return {
                              ...current,
                              end_time: deadlineTiming?.end_time || event.target.value,
                              start_time: deadlineTiming?.start_time || current.start_time,
                            }
                          })}
                        />
                      </div>
                      <div className="knt-form-row">
                        <label>Deadline Rule</label>
                        <p className="knt-hint">开始时间自动回推（默认 30 分钟窗口），用于 Timeline 可视化，不需要手填起点。</p>
                      </div>
                    </div>
                  ) : null}
                  {(cardForm.event_type === 'interval' || cardForm.event_type === 'recurring') ? (
                    <div className="knt-form-grid">
                      <div className="knt-form-row">
                        <label htmlFor="modal-card-start">Start</label>
                        <input
                          id="modal-card-start"
                          type="time"
                          value={cardForm.start_time}
                          onChange={(event) => setCardForm((current) => ({ ...current, start_time: event.target.value }))}
                        />
                      </div>
                      <div className="knt-form-row">
                        <label htmlFor="modal-card-end">End</label>
                        <input
                          id="modal-card-end"
                          type="time"
                          value={cardForm.end_time}
                          onChange={(event) => setCardForm((current) => ({ ...current, end_time: event.target.value }))}
                        />
                      </div>
                      <div className="knt-form-row">
                        <label>Cross-Day Rule</label>
                        <p className="knt-hint">结束时间早于开始时间时，自动按跨天事件处理（+1 day）。</p>
                      </div>
                    </div>
                  ) : null}
                  {cardForm.event_type === 'recurring' ? (
                    <>
                      <div className="knt-form-row">
                        <label htmlFor="modal-card-repeat-rule">Repeat Rule</label>
                        <select
                          id="modal-card-repeat-rule"
                          value={cardForm.repeat_rule}
                          onChange={(event) => setCardForm((current) => ({ ...current, repeat_rule: event.target.value }))}
                        >
                          {REPEAT_RULE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                      {cardForm.repeat_rule === 'weekly' ? (
                        <div className="knt-weekday-grid">
                          {WEEKDAY_OPTIONS.map((weekday) => (
                            <label key={weekday.value} className="knt-weekday-item">
                              <input
                                type="checkbox"
                                checked={cardForm.repeat_weekdays.includes(weekday.value)}
                                onChange={(event) => {
                                  const nextWeekdays = event.target.checked
                                    ? [...cardForm.repeat_weekdays, weekday.value]
                                    : cardForm.repeat_weekdays.filter((item) => item !== weekday.value)
                                  setCardForm((current) => ({
                                    ...current,
                                    repeat_weekdays: normalizeWeekdays(nextWeekdays),
                                  }))
                                }}
                              />
                              <span>{weekday.label}</span>
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  <section className="knt-checklist">
                    <header className="knt-checklist-head">
                      <h3>Checklist</h3>
                      <small className="knt-hint">Checklist 文本支持 Markdown 与 LaTeX。</small>
                      <div className="knt-checklist-add">
                        <input
                          value={newChecklistText}
                          onChange={(event) => setNewChecklistText(event.target.value)}
                          placeholder="New checklist item"
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              handleAddChecklistItem()
                            }
                          }}
                        />
                        <button type="button" className="knt-btn knt-btn--tiny" onClick={handleAddChecklistItem}>
                          Add
                        </button>
                      </div>
                    </header>
                    {(cardForm.checklist || []).length === 0 ? (
                      <p className="knt-empty">暂无 checklist 项。</p>
                    ) : (
                      <div className="knt-checklist-items">
                        {(cardForm.checklist || []).map((item) => (
                          <div key={item.id} className="knt-checklist-item">
                            <input
                              type="checkbox"
                              checked={Boolean(item.done)}
                              onChange={(event) => handleToggleChecklistItem(item.id, event.target.checked)}
                            />
                            <div className="knt-checklist-item-main">
                              <input
                                value={item.text}
                                onChange={(event) => handleUpdateChecklistText(item.id, event.target.value)}
                              />
                              <div className="knt-checklist-preview">
                                <RichText value={item.text || '_空_' } className="knt-richtext knt-richtext--compact" />
                              </div>
                            </div>
                            <button type="button" className="knt-btn knt-btn--tiny is-danger" onClick={() => handleDeleteChecklistItem(item.id)}>
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                </div>
              </section>
            </div>
          ) : null}
        </main>

        <aside className="knt-sidebar">
          <section className="knt-panel">
            <header className="knt-panel-head">
              <h2>Calendar</h2>
              <div className="knt-inline-actions">
                <button type="button" className="knt-btn knt-btn--tiny" onClick={() => setCalendarMonth((current) => shiftMonthKey(current, -1))}>
                  ‹
                </button>
                <span>{calendarLabel}</span>
                <button type="button" className="knt-btn knt-btn--tiny" onClick={() => setCalendarMonth((current) => shiftMonthKey(current, 1))}>
                  ›
                </button>
              </div>
            </header>
            <div className="knt-calendar-grid knt-calendar-grid--weekday">
              {CALENDAR_WEEKDAYS.map((weekday) => (
                <span key={weekday}>{weekday}</span>
              ))}
            </div>
            <div className="knt-calendar-grid">
              {monthCells.map((cell) => (
                <button
                  key={cell.iso}
                  type="button"
                  className={`knt-calendar-cell${cell.inMonth ? '' : ' is-outside'}${cell.iso === selectedDay ? ' is-selected' : ''}${selectedRecurringVisibleDays.has(cell.iso) ? ' is-recurring-focus' : ''}`}
                  onClick={() => { handlePickDay(cell.iso) }}
                >
                  <div className="knt-calendar-cell-head">
                    <strong>{cell.date}</strong>
                    <span className="knt-calendar-cell-marks">
                      {selectedRecurringVisibleDays.has(cell.iso) ? (
                        <span
                          className="knt-calendar-recurring-mark"
                          title="Selected recurring event appears on this day"
                        />
                      ) : null}
                      {cell.inMonth && monthDeadlineCount[cell.iso] > 0 ? (
                        <span
                          className="knt-calendar-deadline-mark"
                          title={`Deadline ${monthDeadlineCount[cell.iso]}`}
                        />
                      ) : null}
                    </span>
                  </div>
                  {cell.inMonth && monthEventCount[cell.iso] > 0 ? (
                    <small>{monthEventCount[cell.iso]} events</small>
                  ) : null}
                </button>
              ))}
            </div>
          </section>

          <section className={`knt-panel knt-panel--timeline${isCardDetailVisible ? ' is-card-detail-open' : ''}`}>
            <header className="knt-panel-head">
              <h2>Timeline Preview</h2>
              <span>{selectedDayLabel}</span>
            </header>
            <div className="knt-timeline-tools">
              <div className="knt-inline-actions">
                <div className="knt-range-toggle" role="tablist" aria-label="Timeline Range">
                  {TIMELINE_RANGE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`knt-range-toggle-btn${timelineRange === option.value ? ' is-active' : ''}`}
                      onClick={() => setTimelineRange(option.value)}
                      aria-selected={timelineRange === option.value}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="knt-btn knt-btn--tiny"
                  onClick={handleJumpNow}
                >
                  Now
                </button>
                <div className="knt-timeline-density">
                  <label htmlFor="timeline-density">密度</label>
                  <input
                    id="timeline-density"
                    type="range"
                    min={DEFAULT_TIMELINE_HOUR_HEIGHT}
                    max={DEFAULT_TIMELINE_HOUR_HEIGHT * 2}
                    step={2}
                    value={timelineHourHeight}
                    onChange={(event) => setTimelineHourHeight(Number(event.target.value))}
                  />
                  <span>{Math.round((timelineHourHeight / DEFAULT_TIMELINE_HOUR_HEIGHT) * 100)}%</span>
                </div>
              </div>
              <span className="knt-timeline-count">{timelineLayout.length} events</span>
            </div>
            {timelineLayout.length > 0 ? (
              <div className="knt-timeline-quicklist">
                {timelineLayout.map((item) => (
                  <button
                    key={`quick-${item.id}-${item.occurrence_date || selectedDay}-${item.segment_index || 0}-${item.start_time}`}
                    type="button"
                    className={`knt-timeline-quickitem${selectedCardId === item.id ? ' is-selected' : ''}`}
                    onClick={() => {
                      if (isCardDetailOpen) {
                        if (item.id === selectedCardId) {
                          handleJumpTimeline(selectedDay, item.start_minutes)
                          return
                        }
                        void attemptSwitchTimelineEvent(item, selectedDay)
                        return
                      }
                      setSelectedCardId(item.id)
                      if (item.lane_id) setSelectedLaneId(item.lane_id)
                      handleJumpTimeline(selectedDay, item.start_minutes)
                    }}
                    onDoubleClick={() => {
                      if (isCardDetailOpen) return
                      if (item.lane_id) setSelectedLaneId(item.lane_id)
                      handleJumpTimeline(selectedDay, item.start_minutes)
                      openCardDetail(item.id)
                    }}
                  >
                    <strong>{item.start_time}</strong>
                    <span>{item.title}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="knt-empty">当天没有时间事件。</p>
            )}
            <div className="knt-timeline-scroll" ref={timelineScrollRef} onScroll={handleTimelineScroll}>
              <div
                className="knt-timeline-canvas"
                ref={timelineCanvasRef}
                style={{ height: `${timelineTotalHeight}px` }}
                onMouseMove={updateTimelineCanvasResizeCursor}
                onMouseLeave={clearTimelineCanvasResizeCursor}
                onMouseDown={handleTimelineCanvasMouseDown}
                onClick={handleTimelineClick}
              >
                {timelineDays.map((day, dayIndex) => {
                  const top = dayIndex * timelineSectionHeight
                  const events = timelineEventsByDay[day] || []
                  return (
                    <header
                      key={`day-head-${day}`}
                      className={`knt-timeline-day-head${isSameIsoDay(day, selectedDay) ? ' is-selected' : ''}`}
                      style={{ top: `${top}px` }}
                      onClick={(event) => {
                        event.stopPropagation()
                        handlePickDay(day)
                      }}
                    >
                      <strong>{monthDayFormatter.format(new Date(`${day}T12:00:00`))}</strong>
                      <span>{events.length} events</span>
                    </header>
                  )
                })}
                {timelineDays.map((day, dayIndex) => (
                  Array.from({ length: 24 }, (_, hour) => (
                    <div
                      key={`${day}-hour-${hour}`}
                      className="knt-hour-line"
                      style={{ top: `${dayIndex * timelineSectionHeight + TIMELINE_DAY_HEADER_HEIGHT + hour * timelineHourHeight}px` }}
                    >
                      <span>{pad(hour)}:00</span>
                    </div>
                  ))
                ))}
                {timelineDays.map((day, dayIndex) => (
                  Array.from({ length: 24 }, (_, hour) => (
                    <div
                      key={`${day}-half-${hour}`}
                      className="knt-half-hour-line"
                      style={{ top: `${dayIndex * timelineSectionHeight + TIMELINE_DAY_HEADER_HEIGHT + hour * timelineHourHeight + timelineHourHeight / 2}px` }}
                    />
                  ))
                ))}
                {(() => {
                  const todayIndex = dayDistance(timelineStartDay, today)
                  if (todayIndex < 0 || todayIndex >= timelineDays.length) return null
                  return (
                    <div
                      className="knt-timeline-now-line"
                      style={{
                        top: `${todayIndex * timelineSectionHeight + TIMELINE_DAY_HEADER_HEIGHT + (nowTime.getHours() * 60 + nowTime.getMinutes()) * (timelineHourHeight / 60)}px`,
                      }}
                    />
                  )
                })()}
                {timelineDays.map((day, dayIndex) => {
                  const dayEvents = timelineEventsByDay[day] || []
                    return dayEvents.map((item) => {
                      const isDeadline = String(item.event_type || 'none') === 'deadline'
                      const enableResizeHandles = Boolean(
                        isCardDetailOpen
                        && item.id === selectedCardId
                        && !isDeadline
                        && String(cardForm.event_type || 'none') !== 'none',
                      )
                      const totalColumns = Math.max(Number(item.total_columns) || 1, 1)
                      const leftRatio = (item.column / totalColumns).toFixed(6)
                      const widthRatio = (1 / totalColumns).toFixed(6)
                      const top = dayIndex * timelineSectionHeight + TIMELINE_DAY_HEADER_HEIGHT + item.start_minutes * (timelineHourHeight / 60)
                      const height = Math.max(item.duration_minutes * (timelineHourHeight / 60), 30)
                      const compact = height <= 36
                      return (
                        <article
                          key={`${day}-${item.id}-${item.occurrence_date || day}-${item.segment_index || 0}-${item.start_time}-${item.end_time}`}
                          className={`knt-timeline-event tone-${item.color || 'slate'}${selectedCardId === item.id ? ' is-selected' : ''}${enableResizeHandles ? ' is-resizable' : ''}${compact && !isDeadline ? ' is-compact' : ''}${isDeadline ? ' is-deadline' : ''}`}
                          style={{
                            top: `${top}px`,
                            height: `${height}px`,
                            left: `calc(var(--timeline-grid-left) + (100% - var(--timeline-grid-left)) * ${leftRatio} + var(--timeline-event-gap))`,
                            width: `calc((100% - var(--timeline-grid-left)) * ${widthRatio} - var(--timeline-event-gap) * 2)`,
                        }}
                        title={isDeadline ? `${item.title} · Deadline ${item.end_time}` : `${item.title} · ${item.start_time}-${item.end_time}`}
                        onMouseMove={(event) => {
                          updateTimelineEventResizeCursor(event, item, isDeadline)
                        }}
                        onMouseLeave={clearTimelineEventResizeCursor}
                        onMouseDown={(event) => {
                          if (event.button !== 0) return
                          const edge = resolveTimelineResizeEdge(event, item, isDeadline)
                          if (!edge) return
                          clearTimelineEventResizeCursor(event)
                          startTimelineResizeDrag(event, edge, item, day)
                        }}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (consumeSuppressedTimelineClick()) return
                          if (isCardDetailOpen) {
                            if (item.id !== selectedCardId) {
                              const switched = attemptSwitchTimelineEvent(item, day)
                              if (switched) return
                            }
                            applyTimelineSelectionAtPointer(event.clientY)
                            return
                          }
                          setSelectedCardId(item.id)
                          if (item.lane_id) setSelectedLaneId(item.lane_id)
                          setSelectedDay(day)
                          setCalendarMonth(day.slice(0, 7))
                        }}
                          onDoubleClick={(event) => {
                            event.stopPropagation()
                            if (isCardDetailOpen) return
                            if (item.lane_id) setSelectedLaneId(item.lane_id)
                            setSelectedDay(day)
                            setCalendarMonth(day.slice(0, 7))
                            openCardDetail(item.id)
                          }}
                        >
                          {isDeadline ? (
                            selectedCardId === item.id ? (
                              <span className="knt-timeline-deadline-label">{item.title} · {item.end_time}</span>
                            ) : null
                          ) : compact ? (
                            <p className="knt-timeline-event-inline">
                              <strong>{item.title}</strong>
                              <span>{item.start_time}-{item.end_time}</span>
                            </p>
                          ) : (
                            <>
                              <strong>{item.title}</strong>
                              <small>{item.start_time} - {item.end_time}</small>
                              <small>{item.lane_title || 'No lane'}</small>
                            </>
                          )}
                        </article>
                      )
                    })
                  })}
                {(() => {
                  if (!isCardDetailOpen || !timelineDraftPreview) return null
                  if (timelineDraftPreview.card_id !== selectedCardId) return null
                  const draftDay = String(timelineDraftPreview.day || '')
                  const dayIndex = dayDistance(timelineStartDay, draftDay)
                  if (dayIndex < 0 || dayIndex >= timelineDays.length) return null
                  const draftStart = Math.max(0, Math.min(Number(timelineDraftPreview.start_minutes) || 0, DAY_MINUTES - 1))
                  const draftEnd = Math.max(draftStart + 1, Math.min(Number(timelineDraftPreview.end_minutes) || (draftStart + 1), DAY_MINUTES))
                  const top = dayIndex * timelineSectionHeight + TIMELINE_DAY_HEADER_HEIGHT + draftStart * (timelineHourHeight / 60)
                  const height = Math.max((draftEnd - draftStart) * (timelineHourHeight / 60), 30)
                  const compact = height <= 36
                  const title = String(timelineDraftPreview.title || 'Untitled')
                  const startText = String(timelineDraftPreview.start_time || formatClockMinutes(draftStart))
                  const endText = String(timelineDraftPreview.end_time || formatClockMinutes(draftEnd))
                  const isDraftDeadline = String(timelineDraftPreview.event_type || 'none') === 'deadline'
                  const draftItem = {
                    id: selectedCardId,
                    lane_id: selectedCard?.lane_id || '',
                    title,
                    event_type: timelineDraftPreview.event_type,
                  }
                  return (
                    <article
                      className={`knt-timeline-event tone-${timelineDraftPreview.color || 'slate'} is-selected${isDraftDeadline ? '' : ' is-resizable'} is-draft-preview${compact ? ' is-compact' : ''}${isDraftDeadline ? ' is-deadline' : ''}`}
                      style={{
                        top: `${top}px`,
                        height: `${height}px`,
                        left: 'calc(var(--timeline-grid-left) + var(--timeline-event-gap))',
                        width: 'calc(100% - var(--timeline-grid-left) - var(--timeline-event-gap) * 2)',
                      }}
                      title={`预览 ${title} · ${startText}-${endText}`}
                      onMouseMove={(event) => {
                        updateTimelineEventResizeCursor(event, draftItem, isDraftDeadline)
                      }}
                      onMouseLeave={clearTimelineEventResizeCursor}
                      onMouseDown={(event) => {
                        if (event.button !== 0) return
                        const edge = resolveTimelineResizeEdge(event, draftItem, isDraftDeadline)
                        if (!edge) return
                        clearTimelineEventResizeCursor(event)
                        startTimelineResizeDrag(event, edge, draftItem, draftDay)
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (consumeSuppressedTimelineClick()) return
                        applyTimelineSelectionAtPointer(event.clientY)
                      }}
                    >
                      {compact ? (
                        <p className="knt-timeline-event-inline">
                          <strong>预览 · {title}</strong>
                          <span>{startText}-{endText}</span>
                        </p>
                      ) : (
                        <>
                          <strong>预览 · {title}</strong>
                          <small>{startText} - {endText}</small>
                          <small>保存后生效</small>
                        </>
                      )}
                    </article>
                  )
                })()}
              </div>
            </div>
          </section>
        </aside>
      </section>

      {(error || notice) ? (
        <div className="knt-toast-stack" aria-live="polite" aria-atomic="true">
          {error ? <div className="knt-toast knt-toast--error">{error}</div> : null}
          {notice ? <div className="knt-toast knt-toast--info">{notice}</div> : null}
        </div>
      ) : null}

      {activeBoard && isBoardEditorOpen ? (
        <div className="knt-detail-modal-mask">
          <section className="knt-detail-modal">
            <header className="knt-detail-modal-head">
              <h2>Board Editor</h2>
              <button type="button" className="knt-modal-close" onClick={() => setIsBoardEditorOpen(false)}>
                ×
              </button>
            </header>
            <div className="knt-editor">
              <div className="knt-board-meta-grid">
                <div className="knt-form-row">
                  <label htmlFor="board-title">Board Title</label>
                  <input
                    id="board-title"
                    value={boardForm.title}
                    onChange={(event) => setBoardForm((current) => ({ ...current, title: event.target.value }))}
                  />
                </div>
                <div className="knt-form-row">
                  <label htmlFor="board-color">Color</label>
                  <select
                    id="board-color"
                    value={boardForm.color}
                    onChange={(event) => setBoardForm((current) => ({ ...current, color: event.target.value }))}
                  >
                    {COLOR_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="knt-form-row">
                <label htmlFor="board-description">Description</label>
                <textarea
                  id="board-description"
                  rows={4}
                  value={boardForm.description}
                  onChange={(event) => setBoardForm((current) => ({ ...current, description: event.target.value }))}
                />
              </div>
              <div className="knt-inline-actions">
                <button type="button" className="knt-btn knt-btn--primary" disabled={saving || !activeBoardId} onClick={() => { void handleSaveBoard() }}>
                  Save Board
                </button>
                <button type="button" className="knt-btn is-danger" disabled={saving || !activeBoardId} onClick={() => { void handleDeleteBoard() }}>
                  Delete Board
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

    </div>
  )
}

export default App
