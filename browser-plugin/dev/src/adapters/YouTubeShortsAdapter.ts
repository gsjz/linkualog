import { IVideoAdapter } from './BaseAdapter';
import { Subtitle } from '../types';

declare const unsafeWindow: any;

export class YouTubeShortsAdapter implements IVideoAdapter {
  platformName = 'YouTube Shorts (Manual CC)';
  private cachedSubs: Subtitle[] = [];
  private listeners: ((subs: Subtitle[]) => void)[] = [];
  private subsMap: Map<string, Subtitle[]> = new Map(); 
  private resizeTimeout: number | null = null;

  constructor() { 
    this.initNetworkHook(); 
    setInterval(() => this.syncSubsToCurrentVideo(), 500);

    window.addEventListener('yt-navigate-finish', () => {
      if (this.match(window.location.href)) {
        this.cachedSubs = [];
        this.listeners.forEach(cb => cb([]));
        this.syncSubsToCurrentVideo();
      }
    });
  }

  match(url: string) { return url.includes('youtube.com/shorts/'); }

  onSubtitleDetected(callback: (subs: Subtitle[]) => void) {
    this.listeners = [callback];
    if (this.cachedSubs.length > 0) callback(this.cachedSubs);
  }

  private getCurrentVideoId(): string | null {
    const match = window.location.pathname.match(/\/shorts\/([^/?]+)/);
    return match ? match[1] : null;
  }

  private getVideoEl(): HTMLVideoElement | null {
    const videos = Array.from(document.querySelectorAll('video'));
    const playingVideo = videos.find(v => !v.paused && v.readyState > 0 && v.getBoundingClientRect().height > 0);
    if (playingVideo) return playingVideo as HTMLVideoElement;

    const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
    if (activeRenderer) {
      const v = activeRenderer.querySelector('video');
      if (v) return v as HTMLVideoElement;
    }

    let bestVideo = null;
    let minDiff = Infinity;
    const centerY = window.innerHeight / 2;

    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      if (rect.height === 0 || rect.width === 0) continue;
      const vCenter = rect.top + rect.height / 2;
      const diff = Math.abs(vCenter - centerY);
      if (diff < minDiff) { minDiff = diff; bestVideo = v; }
    }
    return bestVideo;
  }

  private syncSubsToCurrentVideo() {
    if (!this.match(window.location.href)) return;
    const currentVid = this.getCurrentVideoId();
    if (!currentVid) return;
    const targetSubs = this.subsMap.get(currentVid) || [];
    if (targetSubs.length > 0 && this.cachedSubs !== targetSubs) {
      this.cachedSubs = targetSubs;
      this.listeners.forEach(cb => cb(targetSubs));
    }
  }

  private initNetworkHook() {
    try {
      const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const rawFetch = win.fetch;
      if (rawFetch) {
        win.fetch = async (...args: any[]) => {
          const urlStr = (args[0] instanceof Request) ? args[0].url : args[0];
          if (typeof urlStr !== 'string' || !urlStr.includes('/api/timedtext')) return rawFetch.apply(win, args);
          
          const match = urlStr.match(/[?&]v=([^&]+)/);
          const vid = match ? match[1] : null;

          const response = await rawFetch.apply(win, args);
          response.clone().json().then((data: any) => this.processSubs(data, vid)).catch(() => {});
          return response;
        };
      }
      if (win.XMLHttpRequest) {
        const rawXHR = win.XMLHttpRequest.prototype.open;
        const self = this;
        win.XMLHttpRequest.prototype.open = function(m: string, urlStr: string) {
          if (typeof urlStr === 'string' && urlStr.includes('/api/timedtext')) {
            const match = urlStr.match(/[?&]v=([^&]+)/);
            const vid = match ? match[1] : null;
            this.addEventListener('load', () => { try { self.processSubs(JSON.parse((this as any).responseText), vid); } catch(e) {} });
          }
          return rawXHR.apply(this, arguments as any);
        };
      }
    } catch (error) {}
  }

  private processSubs(data: any, vid: string | null) {
    if (!data || !data.events || !vid) return;
    const newSubs: Subtitle[] = [];
    data.events.forEach((ev: any) => {
      if (!ev.segs) return;
      const text = ev.segs.map((s: any) => s.utf8).join('').trim();
      if (text && text !== '\n') newSubs.push({ text, start: ev.tStartMs / 1000, end: (ev.tStartMs + (ev.dDurationMs || 0)) / 1000 });
    });
    if (newSubs.length > 0) {
      const existing = this.subsMap.get(vid) || [];
      const existingStarts = new Set(existing.map(s => s.start));
      const toAdd = newSubs.filter(s => !existingStarts.has(s.start));
      if (toAdd.length > 0) {
        const updated = [...existing, ...toAdd].sort((a, b) => a.start - b.start);
        this.subsMap.set(vid, updated);
        this.syncSubsToCurrentVideo();
      }
    }
  }

  resizeHost(width: number) {
    document.documentElement.style.setProperty('--linkual-sidebar-width', `${width}px`);
    let styleEl = document.getElementById('linkual-style-patch-shorts');
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'linkual-style-patch-shorts'; document.head.appendChild(styleEl); }
    if (styleEl) {
      styleEl.textContent = `
        html, body { overflow-x: hidden !important; }
        
        /* 同样修复 Shorts 的靠左对齐 */
        ytd-app, #masthead-container { 
          width: calc(100vw - var(--linkual-sidebar-width)) !important; 
          max-width: calc(100vw - var(--linkual-sidebar-width)) !important; 
          left: 0 !important; 
          right: auto !important; 
        }
        
        ytd-shorts { width: 100% !important; position: relative !important; }
        #shorts-container, #shorts-inner-container, ytd-reel-video-renderer { width: 100% !important; max-width: 100% !important; }
      `;
    }
    if (this.resizeTimeout !== null) clearTimeout(this.resizeTimeout);
    this.resizeTimeout = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 150);
  }

  getCurrentTime() { return this.getVideoEl()?.currentTime || 0; }
  seekTo(time: number) { const v = this.getVideoEl(); if (v) v.currentTime = time; }
  play() { this.getVideoEl()?.play(); }
  pause() { this.getVideoEl()?.pause(); }
}