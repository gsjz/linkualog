import { IVideoAdapter } from './BaseAdapter';
import { Subtitle } from '../types';

export class EmptyAdapter implements IVideoAdapter {
  platformName = 'Universal';

  match() {
    return true;
  }

  isVideoPage() {
    return false;
  }

  onSubtitleDetected(callback: (subs: Subtitle[]) => void) {
    callback([]);
  }

  getCurrentTime() {
    return 0;
  }

  seekTo() {}

  play() {}

  pause() {}
}
