import { Subtitle } from '../types';

export interface IVideoAdapter {
  platformName: string;
  match(url: string): boolean;
  onSubtitleDetected(callback: (subs: Subtitle[]) => void): void;
  getCurrentTime(): number;
  seekTo(time: number): void;
  play(): void;
  pause(): void;
  resizeHost?(width: number, height: number, layout: string): void;
  isVideoPage(): boolean;
}