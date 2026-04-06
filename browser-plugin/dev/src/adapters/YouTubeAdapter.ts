import { IVideoAdapter } from './BaseAdapter';
import { Subtitle } from '../types';

declare const unsafeWindow: any;

export class YouTubeAdapter implements IVideoAdapter {
  platformName = 'YouTube';
  private cachedSubs: Subtitle[] = [];
  private listeners: ((subs: Subtitle[]) => void)[] = [];

  private subsMap: Map<string, Subtitle[]> = new Map();

  private resizeTimeout: number | null = null;
  private autoTurnedOn = false;
  private forceRefreshDone = false;

  constructor() {
    this.initNetworkHook();
    this.initFullscreenHook();
    this.initAutoHotkey();

    setInterval(() => this.syncSubsToCurrentVideo(), 500);
  }

  match(url: string) { return url.includes('youtube.com') && !url.includes('/shorts/'); }

  isVideoPage() { return window.location.pathname === '/watch'; }

  onSubtitleDetected(callback: (subs: Subtitle[]) => void) {
    this.listeners = [callback];
    if (this.cachedSubs.length > 0) callback(this.cachedSubs);
  }

  private getCurrentVideoId(): string | null {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v');
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

  private setCaptionsState(state: 'on' | 'off') {
    const script = document.createElement('script');
    script.textContent = `
      try {
        const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        if (player) {
          if ('${state}' === 'on' && typeof player.toggleSubtitlesOn === 'function') {
            player.toggleSubtitlesOn();
          } else if ('${state}' === 'off' && typeof player.toggleSubtitlesOff === 'function') {
            player.toggleSubtitlesOff();
          }
        }
      } catch(e) { console.error('[Linkual] API 调用失败', e); }
    `;
    document.body.appendChild(script);
    script.remove();

    setTimeout(() => {
      const ccButton = document.querySelector('.ytp-subtitles-button') as HTMLButtonElement | null;
      if (ccButton) {
        const isCurrentlyOn = ccButton.getAttribute('aria-pressed') === 'true';
        if (state === 'on' && !isCurrentlyOn) ccButton.click();
        else if (state === 'off' && isCurrentlyOn) ccButton.click();
      }
    }, 150);
  }

  private initAutoHotkey() {
    const tryTriggerCC = () => {
      let attempts = 0;
      const interval = setInterval(() => {
        if (!this.match(window.location.href)) { clearInterval(interval); return; }

        const vid = this.getCurrentVideoId();
        if (!vid) return;

        attempts++;
        if (attempts > 30) { clearInterval(interval); return; }

        const video = this.getVideoEl();
        if (!video || video.readyState === 0) return;

        if (this.subsMap.has(vid) && this.subsMap.get(vid)!.length > 0) {
          clearInterval(interval);
          return;
        }

        const ccButton = document.querySelector('.ytp-subtitles-button') as HTMLButtonElement | null;
        if (ccButton && ccButton.style.display !== 'none') {
          const isPressed = ccButton.getAttribute('aria-pressed') === 'true';

          if (isPressed && !this.forceRefreshDone && attempts > 4) {
            console.log('[Linkual] 字幕开启但错过了数据，强制拉取...');
            this.forceRefreshDone = true;
            this.setCaptionsState('off');
            setTimeout(() => this.setCaptionsState('on'), 400);
            return;
          }

          if (!isPressed) {
            console.log('[Linkual] 模拟开启长视频字幕...');
            this.autoTurnedOn = true;
            this.setCaptionsState('on');
            clearInterval(interval);
          }
        }
      }, 500);
    };

    tryTriggerCC();

    window.addEventListener('yt-navigate-finish', () => {
      if (this.match(window.location.href)) {
        this.cachedSubs = [];
        this.listeners.forEach(cb => cb([]));
        this.autoTurnedOn = false;
        this.forceRefreshDone = false;
        this.syncSubsToCurrentVideo();
        setTimeout(tryTriggerCC, 500);
      }
    });
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
          response.clone().json().then((data: any) => this.processSubs(data, vid)).catch(() => { });
          return response;
        };
      }

      if (win.XMLHttpRequest) {
        const rawXHR = win.XMLHttpRequest.prototype.open;
        const self = this;
        win.XMLHttpRequest.prototype.open = function (m: string, urlStr: string) {
          if (typeof urlStr === 'string' && urlStr.includes('/api/timedtext')) {
            const match = urlStr.match(/[?&]v=([^&]+)/);
            const vid = match ? match[1] : null;
            this.addEventListener('load', () => {
              try { self.processSubs(JSON.parse((this as any).responseText), vid); } catch (e) { }
            });
          }
          return rawXHR.apply(this, arguments as any);
        };
      }
    } catch (error) { }
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

      if (this.autoTurnedOn && this.match(window.location.href) && vid === this.getCurrentVideoId()) {
        this.autoTurnedOn = false;

        let closeAttempts = 0;
        const closeInterval = setInterval(() => {
          closeAttempts++;
          if (closeAttempts > 8) { clearInterval(closeInterval); return; }

          const ccBtn = document.querySelector('.ytp-subtitles-button');
          if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'true') {
            console.log(`[Linkual] 正在静默关闭长视频原生字幕 (第 ${closeAttempts} 次尝试)...`);
            this.setCaptionsState('off');
          } else {
            clearInterval(closeInterval);
          }
        }, 500);
      }
    }
  }

  private initFullscreenHook() {
    document.addEventListener('fullscreenchange', () => {
      const root = document.getElementById('linkual-root');
      if (!root) return;
      const fsElement = document.fullscreenElement;
      if (fsElement && (fsElement.classList.contains('html5-video-player') || fsElement.tagName === 'YTD-WATCH-FLEXY')) {
        fsElement.appendChild(root);
      } else if (!fsElement) {
        document.body.appendChild(root);
      }
    });
  }

  resizeHost(width: number, height: number, layout: string) {
    document.documentElement.style.setProperty('--linkual-sidebar-width', layout === 'right' ? `${width}px` : '0px');
    document.documentElement.style.setProperty('--linkual-sidebar-height', layout === 'bottom' ? `${height}px` : '0px');
    
    let styleEl = document.getElementById('linkual-style-patch');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'linkual-style-patch';
      document.head.appendChild(styleEl);
    }
    
    if (layout === 'right') {
      styleEl.textContent = `
        html, body { overflow-x: hidden !important; }
        ytd-app, #masthead-container { 
          width: calc(100vw - var(--linkual-sidebar-width)) !important; 
          max-width: calc(100vw - var(--linkual-sidebar-width)) !important; 
          left: 0 !important; right: auto !important; margin-bottom: 0 !important;
        }
        ytd-watch-flexy[theater] #player-theater-container, 
        ytd-watch-flexy[theater] #player-full-bleed-container,
        ytd-watch-flexy[theater] #full-bleed-container, 
        ytd-watch-flexy[theater] #cinematics-container, 
        ytd-watch-flexy[theater] #cinematics,
        ytd-watch-flexy[theater] ytd-player,
        ytd-watch-flexy[theater] .html5-video-player { 
          width: calc(100vw - var(--linkual-sidebar-width)) !important; 
          max-width: calc(100vw - var(--linkual-sidebar-width)) !important; 
          min-height: 0 !important; 
          height: calc((100vw - var(--linkual-sidebar-width)) * 9 / 16) !important; 
          max-height: calc(100vh - 56px) !important; 
          margin: 0 !important; transform: none !important; 
        }
        .html5-video-player .html5-video-container, .html5-video-player video { 
          width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; margin: 0 !important; object-fit: contain !important;
        }
        .html5-video-player .ytp-chrome-bottom { width: calc(100% - 24px) !important; left: 12px !important; margin: 0 !important; }
      `;
    } else {
      styleEl.textContent = `
        html, body { overflow-x: hidden !important; }
        ytd-app, #masthead-container { 
          width: 100vw !important; max-width: 100vw !important; left: 0 !important; right: auto !important; 
          margin-bottom: var(--linkual-sidebar-height) !important; 
        }
        ytd-watch-flexy[theater] #player-theater-container, 
        ytd-watch-flexy[theater] #player-full-bleed-container,
        ytd-watch-flexy[theater] #full-bleed-container, 
        ytd-watch-flexy[theater] #cinematics-container, 
        ytd-watch-flexy[theater] #cinematics,
        ytd-watch-flexy[theater] ytd-player,
        ytd-watch-flexy[theater] .html5-video-player { 
          width: 100vw !important; max-width: 100vw !important; min-height: 0 !important; 
          height: calc(100vw * 9 / 16) !important; 
          max-height: calc(100vh - var(--linkual-sidebar-height) - 56px) !important; 
          margin: 0 auto !important; transform: none !important; 
        }
        .html5-video-player .html5-video-container, .html5-video-player video { 
          width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; margin: 0 !important; object-fit: contain !important;
        }
        .html5-video-player .ytp-chrome-bottom { width: calc(100% - 24px) !important; left: 12px !important; margin: 0 !important; }
      `;
    }

    if (this.resizeTimeout !== null) clearTimeout(this.resizeTimeout);
    this.resizeTimeout = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 150);
  }

  private getVideoEl() { return document.querySelector('video'); }
  getCurrentTime() { return this.getVideoEl()?.currentTime || 0; }
  seekTo(time: number) { const v = this.getVideoEl(); if (v) v.currentTime = time; }
  play() { this.getVideoEl()?.play(); }
  pause() { this.getVideoEl()?.pause(); }
}