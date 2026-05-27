import { IVideoAdapter } from './BaseAdapter';
import { Subtitle } from '../types';
import {
  fetchYouTubeCaptionsFromPlayer,
  getTimedTextVideoId,
  isEnglishTimedTextUrl,
  parseYouTubeTimedTextPayload,
} from './youtubeCaptions';

declare const unsafeWindow: any;

export class YouTubeAdapter implements IVideoAdapter {
  platformName = 'YouTube';
  private cachedSubs: Subtitle[] = [];
  private listeners: ((subs: Subtitle[]) => void)[] = [];

  private subsMap: Map<string, Subtitle[]> = new Map();

  private resizeTimeout: number | null = null;
  private captionFetchTimeout: number | null = null;
  private captionFetchInFlight: string | null = null;
  private autoTurnedOn = false;
  private forceRefreshDone = false;
  private customFullscreenEnabled = false;

  constructor() {
    this.initNetworkHook();
    this.initFullscreenHook();
    this.initAutoHotkey();

    setInterval(() => this.syncSubsToCurrentVideo(), 500);
    setInterval(() => this.requestCurrentCaptions(), 2000);
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

  private mergeSubs(vid: string | null, newSubs: Subtitle[]) {
    if (!vid || newSubs.length === 0) return false;

    const existing = this.subsMap.get(vid) || [];
    const existingKeys = new Set(existing.map(s => `${Math.round(s.start * 1000)}:${s.text}`));
    const toAdd = newSubs.filter(s => !existingKeys.has(`${Math.round(s.start * 1000)}:${s.text}`));

    if (toAdd.length === 0) return false;

    const updated = [...existing, ...toAdd].sort((a, b) => a.start - b.start);
    this.subsMap.set(vid, updated);
    this.syncSubsToCurrentVideo();
    return true;
  }

  private getPlayerEl(): HTMLElement | null {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  private requestCurrentCaptions(delay = 0) {
    if (!this.match(window.location.href)) return;
    const vid = this.getCurrentVideoId();
    if (!vid || (this.subsMap.get(vid)?.length || 0) > 0) return;

    if (this.captionFetchTimeout !== null) clearTimeout(this.captionFetchTimeout);
    this.captionFetchTimeout = window.setTimeout(() => {
      if (!this.match(window.location.href)) return;
      const currentVid = this.getCurrentVideoId();
      if (!currentVid || (this.subsMap.get(currentVid)?.length || 0) > 0) return;
      if (this.captionFetchInFlight === currentVid) return;

      this.captionFetchInFlight = currentVid;
      fetchYouTubeCaptionsFromPlayer(currentVid, { playerEl: this.getPlayerEl(), win: typeof unsafeWindow !== 'undefined' ? unsafeWindow : window })
        .then((result) => {
          if (result?.subtitles.length) {
            this.mergeSubs(result.videoId || currentVid, result.subtitles);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (this.captionFetchInFlight === currentVid) this.captionFetchInFlight = null;
        });
    }, delay);
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

        this.requestCurrentCaptions();

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
        this.requestCurrentCaptions(300);
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

          const vid = getTimedTextVideoId(urlStr);

          const response = await rawFetch.apply(win, args);
          if (isEnglishTimedTextUrl(urlStr)) {
            response.clone().text().then((text: string) => this.processSubs(text, vid)).catch(() => { });
          }
          return response;
        };
      }

      if (win.XMLHttpRequest) {
        const rawXHR = win.XMLHttpRequest.prototype.open;
        const self = this;
        win.XMLHttpRequest.prototype.open = function (m: string, urlStr: string) {
          if (typeof urlStr === 'string' && urlStr.includes('/api/timedtext')) {
            const vid = getTimedTextVideoId(urlStr);
            if (isEnglishTimedTextUrl(urlStr)) {
              this.addEventListener('load', () => {
                try { self.processSubs((this as any).responseText, vid); } catch (e) { }
              });
            }
          }
          return rawXHR.apply(this, arguments as any);
        };
      }
    } catch (error) { }
  }

  private processSubs(data: any, vid: string | null) {
    const newSubs = parseYouTubeTimedTextPayload(data);

    if (newSubs.length > 0) {
      this.mergeSubs(vid, newSubs);

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

  private refreshCustomFullscreenLayout() {
    const dispatchResize = () => {
      window.dispatchEvent(new Event('resize'));
      document.getElementById('movie_player')?.dispatchEvent(new Event('resize'));
    };

    dispatchResize();
    window.setTimeout(dispatchResize, 80);
    window.setTimeout(dispatchResize, 250);
  }

  private restoreRegularPlayerLayout() {
    window.dispatchEvent(new Event('resize'));
    document.getElementById('movie_player')?.dispatchEvent(new Event('resize'));
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 120);
  }

  resizeHost(width: number, height: number, layout: string) {
    let styleEl = document.getElementById('linkual-style-patch');

    if (width === 0 && height === 0 && !this.customFullscreenEnabled) {
      document.documentElement.style.removeProperty('--linkual-sidebar-width');
      document.documentElement.style.removeProperty('--linkual-sidebar-height');
      if (styleEl) styleEl.textContent = '';
      if (this.resizeTimeout !== null) clearTimeout(this.resizeTimeout);
      this.resizeTimeout = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 150);
      return;
    }

    document.documentElement.style.setProperty('--linkual-sidebar-width', layout === 'right' ? `${width}px` : '0px');
    document.documentElement.style.setProperty('--linkual-sidebar-height', layout === 'bottom' ? `${height}px` : '0px');

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'linkual-style-patch';
      document.head.appendChild(styleEl);
    }

    const customFullscreenCss = `
      html.linkual-custom-fullscreen,
      html.linkual-custom-fullscreen body {
        overflow: hidden !important;
      }
      html.linkual-custom-fullscreen ytd-app {
        position: fixed !important;
        inset: 0 !important;
        width: calc(100vw - var(--linkual-sidebar-width, 0px)) !important;
        max-width: calc(100vw - var(--linkual-sidebar-width, 0px)) !important;
        height: calc(100vh - var(--linkual-sidebar-height, 0px) - var(--linkual-universal-widget-height, 0px)) !important;
        max-height: calc(100vh - var(--linkual-sidebar-height, 0px) - var(--linkual-universal-widget-height, 0px)) !important;
        margin: 0 !important;
        background: #000 !important;
        z-index: 2147483000 !important;
      }
      html.linkual-custom-fullscreen #masthead-container,
      html.linkual-custom-fullscreen ytd-miniplayer,
      html.linkual-custom-fullscreen ytd-guide-renderer,
      html.linkual-custom-fullscreen #related,
      html.linkual-custom-fullscreen #secondary,
      html.linkual-custom-fullscreen #below,
      html.linkual-custom-fullscreen #comments,
      html.linkual-custom-fullscreen ytd-watch-metadata,
      html.linkual-custom-fullscreen ytd-merch-shelf-renderer,
      html.linkual-custom-fullscreen ytd-engagement-panel-section-list-renderer,
      html.linkual-custom-fullscreen ytd-live-chat-frame {
        display: none !important;
      }
      html.linkual-custom-fullscreen ytd-watch-flexy,
      html.linkual-custom-fullscreen #columns,
      html.linkual-custom-fullscreen #primary,
      html.linkual-custom-fullscreen #primary-inner,
      html.linkual-custom-fullscreen #player,
      html.linkual-custom-fullscreen #player-container,
      html.linkual-custom-fullscreen #player-container-outer,
      html.linkual-custom-fullscreen #player-theater-container,
      html.linkual-custom-fullscreen #player-full-bleed-container,
      html.linkual-custom-fullscreen #full-bleed-container,
      html.linkual-custom-fullscreen ytd-player,
      html.linkual-custom-fullscreen .html5-video-player {
        position: fixed !important;
        inset: 0 auto auto 0 !important;
        width: calc(100vw - var(--linkual-sidebar-width, 0px)) !important;
        max-width: calc(100vw - var(--linkual-sidebar-width, 0px)) !important;
        height: calc(100vh - var(--linkual-sidebar-height, 0px) - var(--linkual-universal-widget-height, 0px)) !important;
        max-height: calc(100vh - var(--linkual-sidebar-height, 0px) - var(--linkual-universal-widget-height, 0px)) !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        transform: none !important;
        background: #000 !important;
      }
      html.linkual-custom-fullscreen .html5-video-player .ytp-chrome-top,
      html.linkual-custom-fullscreen .html5-video-player .ytp-chrome-bottom,
      html.linkual-custom-fullscreen .html5-video-player .ytp-gradient-top,
      html.linkual-custom-fullscreen .html5-video-player .ytp-gradient-bottom,
      html.linkual-custom-fullscreen .html5-video-player .ytp-pause-overlay,
      html.linkual-custom-fullscreen .html5-video-player .ytp-cards-teaser,
      html.linkual-custom-fullscreen .html5-video-player .ytp-ce-element,
      html.linkual-custom-fullscreen .html5-video-player .ytp-iv-player-content,
      html.linkual-custom-fullscreen .html5-video-player .ytp-player-content,
      html.linkual-custom-fullscreen .html5-video-player .ytp-caption-window-container {
        display: none !important;
      }
      html.linkual-custom-fullscreen .html5-video-container,
      html.linkual-custom-fullscreen .html5-video-player video {
        width: 100% !important;
        height: 100% !important;
        left: 0 !important;
        top: 0 !important;
        margin: 0 !important;
        object-fit: contain !important;
      }
    `;

    if (layout === 'right') {
      styleEl.textContent = `
        html, body { overflow-x: hidden !important; }
        ytd-app, #masthead-container {
          width: calc(100vw - var(--linkual-sidebar-width)) !important;
          max-width: calc(100vw - var(--linkual-sidebar-width)) !important;
          left: 0 !important; right: auto !important; margin-bottom: var(--linkual-universal-widget-height, 0px) !important;
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
          max-height: calc(100vh - var(--linkual-universal-widget-height, 0px) - 56px) !important;
          margin: 0 !important; transform: none !important;
        }
        ytd-watch-flexy[theater] .html5-video-player .html5-video-container,
        ytd-watch-flexy[theater] .html5-video-player video {
          width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; margin: 0 !important; object-fit: contain !important;
        }
        ${customFullscreenCss}
      `;
    } else {
      styleEl.textContent = `
        html, body { overflow-x: hidden !important; }
        ytd-app, #masthead-container {
          width: 100vw !important; max-width: 100vw !important; left: 0 !important; right: auto !important;
          margin-bottom: calc(var(--linkual-sidebar-height) + var(--linkual-universal-widget-height, 0px)) !important;
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
          max-height: calc(100vh - var(--linkual-sidebar-height) - var(--linkual-universal-widget-height, 0px) - 56px) !important;
          margin: 0 auto !important; transform: none !important;
        }
        ytd-watch-flexy[theater] .html5-video-player .html5-video-container,
        ytd-watch-flexy[theater] .html5-video-player video {
          width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; margin: 0 !important; object-fit: contain !important;
        }
        ${customFullscreenCss}
      `;
    }

    if (this.resizeTimeout !== null) clearTimeout(this.resizeTimeout);
    this.resizeTimeout = window.setTimeout(() => {
      if (this.customFullscreenEnabled) {
        this.refreshCustomFullscreenLayout();
      } else {
        this.restoreRegularPlayerLayout();
      }
    }, 150);
  }

  setCustomFullscreen(enabled: boolean) {
    this.customFullscreenEnabled = enabled;
    if (enabled) {
      this.setCaptionsState('off');
    }
    if (this.resizeTimeout !== null) clearTimeout(this.resizeTimeout);
    this.resizeTimeout = window.setTimeout(() => {
      if (enabled) {
        this.refreshCustomFullscreenLayout();
      } else {
        this.restoreRegularPlayerLayout();
      }
    }, 150);
  }

  private getVideoEl() { return document.querySelector('video'); }
  getCurrentTime() { return this.getVideoEl()?.currentTime || 0; }
  getDuration() { const duration = this.getVideoEl()?.duration || 0; return Number.isFinite(duration) ? duration : 0; }
  isPaused() { return this.getVideoEl()?.paused ?? true; }
  seekTo(time: number) { const v = this.getVideoEl(); if (v) v.currentTime = time; }
  play() { this.getVideoEl()?.play(); }
  pause() { this.getVideoEl()?.pause(); }
}
