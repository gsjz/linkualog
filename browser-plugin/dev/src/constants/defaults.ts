const defaultTzOffset = String(0 - new Date().getTimezoneOffset() / 60);

export const DEFAULTS = {
  theme_color: '#6a1b9a',
  done_color: '#e8f5e9',
  error_color: '#ffebee',
  api_timeout: '15',
  api_url: 'https://api.siliconflow.cn/v1/chat/completions',
  api_model: 'Qwen/Qwen3-8B',
  api_ctxSize: '2',
  api_prompt: '请先给出【目标字幕】所在的完整句子，然后结合上下文解释【目标字幕】中的较难词汇（带上音标），尽量简短。',
  api_key: '',
  sidebar_width: '500',
  lan_sync_url: 'http://127.0.0.1:5000/api/sync',
  lan_action: 'sync',
  lan_message: '来自 Linkual 的字幕同步数据',
  lan_timezone: defaultTzOffset,
  lan_textarea_height: '200'
};