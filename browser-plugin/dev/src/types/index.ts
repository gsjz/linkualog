export interface Subtitle {
  text: string;
  start: number;
  end: number;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | any[];
  isError?: boolean;
}

export interface AppSettings {
  color: string;
  doneColor: string;
  errorColor: string;
  timeoutSec: string;
  url: string;
  model: string;
  key: string;
  ctxSize: string;
  prompt: string;
  sidebarWidth: string;
}