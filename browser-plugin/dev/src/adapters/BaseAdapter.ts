import { Subtitle } from '../types';

export interface IVideoAdapter {
  platformName: string;
  match(url: string): boolean;
  onSubtitleDetected(callback: (subs: Subtitle[]) => void): void;
  getCurrentTime(): number;
  seekTo(time: number): void;
  play(): void;
  pause(): void;
  getDuration?(): number;
  isPaused?(): boolean;
  resizeHost?(width: number, height: number, layout: string): void;
  setCustomFullscreen?(enabled: boolean): void;
  isVideoPage(): boolean;
}
