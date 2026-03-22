import { IVideoAdapter } from './BaseAdapter';
import { Subtitle } from '../types';

export class LocalAdapter implements IVideoAdapter {
  platformName = 'Localhost (Mock)';
  private mockTime = 0;
  private timer: any;
  private isPlaying = false;

  match(url: string) {
    return url.includes('localhost') || url.includes('127.0.0.1');
  }

  onSubtitleDetected(callback: (subs: Subtitle[]) => void) {
    setTimeout(() => {
      callback([
        { text: '欢迎使用 Link-ual 本地开发模式', start: 0, end: 3 },
        { text: '现在你可以脱离视频网站独立调试 UI 和 LLM 聊天了', start: 4, end: 8 },
        { text: '点击播放按钮，时间会模拟自动流逝', start: 9, end: 15 },
        { text: 'This is a test for English translation.', start: 16, end: 20 },
      ]);
    }, 1000);
  }

  getCurrentTime() { return this.mockTime; }
  
  seekTo(time: number) { this.mockTime = time; }
  
  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.timer = setInterval(() => { this.mockTime += 0.1; }, 100);
  }
  
  pause() {
    this.isPlaying = false;
    clearInterval(this.timer);
  }
}