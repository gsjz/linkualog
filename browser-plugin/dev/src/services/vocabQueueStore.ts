import { GM_getValue, GM_setValue } from '$';
import { ConfigService } from './configService';

export interface VocabLlmResult {
  definitions?: string[];
  examples?: Array<{
    text?: string;
    explanation?: string;
    focusWords?: string[];
  }>;
  explanation?: string;
  context_translation?: string;
}

export interface VocabTask {
  id: string;
  word: string;
  context: string;
  source: string;
  source_url?: string;
  youtube?: { url: string; timestamp: number };
  date: string;
  category: string;
  status: 'idle' | 'fetching_llm' | 'sending' | 'success' | 'failed';
  error: string | null;
  rawJson?: string;
  llmResult?: VocabLlmResult;
}

export interface VocabTaskInput {
  word: string;
  context?: string;
  source?: string;
  source_url?: string;
  youtube?: { url: string; timestamp: number };
  category?: string;
}

interface QueueSnapshot {
  tasks: VocabTask[];
  updatedAt: number;
}

interface QueueEnvelope {
  schema: typeof QUEUE_STORAGE_SCHEMA;
  version: 1;
  updatedAt: number;
  tasks: VocabTask[];
}

export const QUEUE_STORAGE_KEY = 'linkual_vocab_queue';
export const QUEUE_COUNT_EVENT = 'linkual_vocab_queue_count';
export const QUEUE_TOGGLE_EVENT = 'linkual_vocab_queue_toggle';
export const QUEUE_REQUEST_COUNT_EVENT = 'linkual_vocab_queue_request_count';
export const QUEUE_CHANGED_EVENT = 'linkual_vocab_queue_changed';

const QUEUE_STORAGE_SCHEMA = 'linkual_vocab_queue';
let lastQueueUpdatedAt = 0;

export const sanitizeLlmResult = (value: unknown): VocabLlmResult => {
  if (!value || typeof value !== 'object') return {};

  const raw = value as Record<string, unknown>;
  const result: VocabLlmResult = {};

  if (Array.isArray(raw.definitions)) {
    const definitions = raw.definitions
      .map(item => String(item || '').trim())
      .filter(Boolean);
    if (definitions.length > 0) result.definitions = definitions;
  }

  if (Array.isArray(raw.examples)) {
    const examples = raw.examples
      .filter(item => item && typeof item === 'object')
      .map((item) => {
        const rawExample = item as Record<string, unknown>;
        const example: NonNullable<VocabLlmResult['examples']>[number] = {};
        const text = String(rawExample.text || '').trim();
        const explanation = String(rawExample.explanation || '').trim();
        const focusWords = Array.isArray(rawExample.focusWords)
          ? rawExample.focusWords.map(word => String(word || '').trim()).filter(Boolean)
          : [];

        if (text) example.text = text;
        if (explanation) example.explanation = explanation;
        if (focusWords.length > 0) example.focusWords = focusWords;
        return example;
      })
      .filter(example => example.text || example.explanation || example.focusWords?.length);

    if (examples.length > 0) result.examples = examples;
  }

  const explanation = String(raw.explanation || '').trim();
  if (explanation) result.explanation = explanation;

  const contextTranslation = String(raw.context_translation || '').trim();
  if (contextTranslation) result.context_translation = contextTranslation;

  return result;
};

export const getLlmExplanation = (result?: VocabLlmResult) => (
  result?.examples?.find(example => example.explanation)?.explanation
  || result?.explanation
  || result?.context_translation
  || ''
);

export const hasUsableLlmResult = (result?: VocabLlmResult) => Boolean(
  result?.definitions?.length
  || result?.examples?.length
  || getLlmExplanation(result)
);

export const canSendTask = (task: VocabTask) => task.status === 'idle' || task.status === 'failed';

export const sanitizeTask = (task: VocabTask): VocabTask => {
  const sanitizedResult = sanitizeLlmResult(task.llmResult);
  return {
    ...task,
    source_url: typeof task.source_url === 'string' ? task.source_url : '',
    llmResult: hasUsableLlmResult(sanitizedResult) ? sanitizedResult : undefined,
  };
};

const parseQueueSnapshot = (rawValue: unknown): QueueSnapshot | null => {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;

  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    parsed = JSON.parse(rawValue);
  }

  if (Array.isArray(parsed)) {
    return {
      tasks: parsed.map(sanitizeTask),
      updatedAt: 0,
    };
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const envelope = parsed as Partial<QueueEnvelope>;
  if (!Array.isArray(envelope.tasks)) return null;

  const updatedAt = Number(envelope.updatedAt || 0);
  return {
    tasks: envelope.tasks.map(sanitizeTask),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
};

export const readStoredQueueSnapshot = (): QueueSnapshot => {
  const snapshots: QueueSnapshot[] = [];

  try {
    if (typeof GM_getValue !== 'undefined') {
      const snapshot = parseQueueSnapshot(GM_getValue(QUEUE_STORAGE_KEY));
      if (snapshot) snapshots.push(snapshot);
    }
  } catch (e) {}

  try {
    const snapshot = parseQueueSnapshot(localStorage.getItem(QUEUE_STORAGE_KEY));
    if (snapshot) snapshots.push(snapshot);
  } catch (e) {}

  if (snapshots.length === 0) return { tasks: [], updatedAt: 0 };

  return snapshots.reduce((latest, snapshot) => {
    if (snapshot.updatedAt > latest.updatedAt) return snapshot;
    if (snapshot.updatedAt === latest.updatedAt && snapshot.tasks.length > latest.tasks.length) return snapshot;
    return latest;
  });
};

export const readStoredQueue = (): VocabTask[] => readStoredQueueSnapshot().tasks;

const getNextUpdatedAt = (baseUpdatedAt = 0) => {
  const next = Math.max(Date.now(), lastQueueUpdatedAt + 1, baseUpdatedAt + 1);
  lastQueueUpdatedAt = next;
  return next;
};

export const writeStoredQueue = (tasks: VocabTask[]) => {
  const latest = readStoredQueueSnapshot();
  const envelope: QueueEnvelope = {
    schema: QUEUE_STORAGE_SCHEMA,
    version: 1,
    updatedAt: getNextUpdatedAt(latest.updatedAt),
    tasks: tasks.map(sanitizeTask),
  };
  const serialized = JSON.stringify(envelope);
  let wrote = false;

  try {
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue(QUEUE_STORAGE_KEY, serialized);
      wrote = true;
    }
  } catch (e) {}

  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, serialized);
    wrote = true;
  } catch (e) {}

  if (!wrote) {
    throw new Error('队列写入失败');
  }

  return envelope;
};

export const clearStoredQueue = () => {
  const envelope = writeStoredQueue([]);
  emitQueueCount(envelope.tasks);
  window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT, {
    detail: { tasks: envelope.tasks, updatedAt: envelope.updatedAt },
  }));
};

export const emitQueueCount = (tasks: VocabTask[]) => {
  window.dispatchEvent(new CustomEvent(QUEUE_COUNT_EVENT, {
    detail: { pendingCount: tasks.filter(t => t.status !== 'success').length },
  }));
};

export const emitQueueChanged = (tasks: VocabTask[], updatedAt?: number) => {
  emitQueueCount(tasks);
  window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT, {
    detail: { tasks, updatedAt },
  }));
};

export const createVocabTask = (input: VocabTaskInput): VocabTask => {
  const dateObj = new Date();
  const systemDate = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
  const word = String(input.word || '').trim();
  const context = String(input.context || '').trim();
  const source = String(input.source || '').trim();
  if (!word) throw new Error('词块不能为空');

  return {
    id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    word,
    context,
    source,
    source_url: input.source_url || input.youtube?.url || window.location.href,
    youtube: input.youtube,
    date: systemDate,
    category: input.category || ConfigService.get('lan_action') as string || 'Video_Sync',
    status: 'idle',
    error: null,
  };
};

export const enqueueVocabTask = (input: VocabTaskInput) => {
  const task = createVocabTask(input);
  const current = readStoredQueue();
  const nextTasks = [task, ...current];
  const envelope = writeStoredQueue(nextTasks);

  emitQueueChanged(envelope.tasks, envelope.updatedAt);
  return task;
};
