import { YouTubeShortsAdapter } from './YouTubeShortsAdapter';
import { YouTubeAdapter } from './YouTubeAdapter';
import { LocalAdapter } from './LocalAdapter';
import { EmptyAdapter } from './EmptyAdapter';
import { IVideoAdapter } from './BaseAdapter';

type AdapterKey = 'youtubeShorts' | 'youtube' | 'local' | 'empty';

const adapterCache = new Map<AdapterKey, IVideoAdapter>();

function getCachedAdapter(key: AdapterKey, createAdapter: () => IVideoAdapter) {
  const cached = adapterCache.get(key);
  if (cached) return cached;

  const adapter = createAdapter();
  adapterCache.set(key, adapter);
  return adapter;
}

function isYouTubeUrl(url: string) {
  return url.includes('youtube.com');
}

export function getAdapter(): IVideoAdapter {
  const url = window.location.href;

  if (isYouTubeUrl(url)) {
    const shortsAdapter = getCachedAdapter('youtubeShorts', () => new YouTubeShortsAdapter());
    const youtubeAdapter = getCachedAdapter('youtube', () => new YouTubeAdapter());

    if (shortsAdapter.match(url)) return shortsAdapter;
    if (youtubeAdapter.match(url)) return youtubeAdapter;
  }

  const localAdapter = getCachedAdapter('local', () => new LocalAdapter());
  if (localAdapter.match(url)) {
    return localAdapter;
  }

  return getCachedAdapter('empty', () => new EmptyAdapter());
}
