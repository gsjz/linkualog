import { YouTubeShortsAdapter } from './YouTubeShortsAdapter';
import { YouTubeAdapter } from './YouTubeAdapter';
import { LocalAdapter } from './LocalAdapter';
import { IVideoAdapter } from './BaseAdapter';

const adapters = [
  new YouTubeShortsAdapter(), 
  new YouTubeAdapter(), 
  new LocalAdapter()
];

export function getAdapter(): IVideoAdapter {
  const url = window.location.href;
  
  for (const adapter of adapters) {
    if (adapter.match(url)) return adapter;
  }
  
  return adapters[2];
}