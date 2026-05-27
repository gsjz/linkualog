import { IVideoAdapter } from './BaseAdapter';
import { Subtitle } from '../types';
import {
  fetchYouTubeCaptionsFromPlayer,
  getTimedTextVideoId,
  isEnglishTimedTextUrl,
  parseYouTubeTimedTextPayload,
} from './youtubeCaptions';

declare const unsafeWindow: any;

export class YouTubeShortsAdapter implements IVideoAdapter {
  platformName = 'YouTube Shorts (Manual CC)';
  private cachedSubs: Subtitle[] = [];
  private listeners: ((subs: Subtitle[]) => void)[] = [];
  private subsMap: Map<string, Subtitle[]> = new Map();
  private resizeTimeout: number | null = null;
  private captionFetchTimeout: number | null = null;
  private captionFetchInFlight: string | null = null;
  private customFullscreenEnabled = false;
  private resumeOnCustomFullscreen = false;

  constructor() {
    this.initNetworkHook();
    setInterval(() => this.syncSubsToCurrentVideo(), 500);
    setInterval(() => this.requestCurrentCaptions(), 2000);

    window.addEventListener('yt-navigate-finish', () => {
      if (this.match(window.location.href)) {
        this.cachedSubs = [];
        this.listeners.forEach(cb => cb([]));
        this.syncSubsToCurrentVideo();
        this.requestCurrentCaptions(300);
      }
    });
  }

  match(url: string) { return url.includes('youtube.com/shorts/'); }

  isVideoPage() { return window.location.pathname.startsWith('/shorts/'); }

  onSubtitleDetected(callback: (subs: Subtitle[]) => void) {
    this.listeners = [callback];
    if (this.cachedSubs.length > 0) callback(this.cachedSubs);
  }

  private getCurrentVideoId(): string | null {
    const match = window.location.pathname.match(/\/shorts\/([^/?]+)/);
    return match ? match[1] : null;
  }

  private getVideoEl(): HTMLVideoElement | null {
    const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
    if (activeRenderer) {
      const v = activeRenderer.querySelector('video');
      if (v) return v as HTMLVideoElement;
    }

    const videos = Array.from(document.querySelectorAll('video'));
    const playingVideo = videos.find(v => !v.paused && v.readyState > 0 && v.getBoundingClientRect().height > 0);
    if (playingVideo) return playingVideo as HTMLVideoElement;

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

  private getPlayerEl(): HTMLElement | null {
    const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
    const activePlayer = activeRenderer?.querySelector('.html5-video-player');
    if (activePlayer) return activePlayer as HTMLElement;
    return document.querySelector('.html5-video-player');
  }

  private callPlayerMethod(methodName: string, ...args: unknown[]) {
    const player = this.getPlayerEl() as any;
    if (player && typeof player[methodName] === 'function') {
      try { player[methodName](...args); } catch (error) {}
    }
  }

  private playActiveVideo() {
    this.callPlayerMethod('playVideo');
    const playResult = this.getVideoEl()?.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => {});
    }
  }

  private resumeActiveVideoSoon() {
    const resume = () => {
      if (this.customFullscreenEnabled && this.resumeOnCustomFullscreen) {
        this.playActiveVideo();
      }
    };

    resume();
    window.setTimeout(resume, 80);
    window.setTimeout(resume, 250);
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
            response.clone().text().then((text: string) => this.processSubs(text, vid)).catch(() => {});
          }
          return response;
        };
      }
      if (win.XMLHttpRequest) {
        const rawXHR = win.XMLHttpRequest.prototype.open;
        const self = this;
        win.XMLHttpRequest.prototype.open = function(m: string, urlStr: string) {
          if (typeof urlStr === 'string' && urlStr.includes('/api/timedtext')) {
            const vid = getTimedTextVideoId(urlStr);
            if (isEnglishTimedTextUrl(urlStr)) {
              this.addEventListener('load', () => { try { self.processSubs((this as any).responseText, vid); } catch(e) {} });
            }
          }
          return rawXHR.apply(this, arguments as any);
        };
      }
    } catch (error) {}
  }

  private processSubs(data: any, vid: string | null) {
    this.mergeSubs(vid, parseYouTubeTimedTextPayload(data));
  }

  private refreshCustomFullscreenLayout() {
    const dispatchResize = () => {
      const player = this.getPlayerEl();
      window.dispatchEvent(new Event('resize'));
      player?.dispatchEvent(new Event('resize'));
      this.getVideoEl()?.dispatchEvent(new Event('resize'));
    };

    dispatchResize();
    window.setTimeout(dispatchResize, 80);
    window.setTimeout(dispatchResize, 250);
  }

  private restoreRegularPlayerLayout() {
    const player = this.getPlayerEl();
    window.dispatchEvent(new Event('resize'));
    player?.dispatchEvent(new Event('resize'));
    this.getVideoEl()?.dispatchEvent(new Event('resize'));
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 120);
  }

  resizeHost(width: number, height: number, layout: string) {
    let styleEl = document.getElementById('linkual-style-patch-shorts');

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

    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'linkual-style-patch-shorts'; document.head.appendChild(styleEl); }

    const customFullscreenCss = `
      html.linkual-custom-fullscreen,
      html.linkual-custom-fullscreen body {
        overflow: hidden !important;
        background: #000 !important;
      }
      html.linkual-custom-fullscreen #masthead-container,
      html.linkual-custom-fullscreen ytd-guide-renderer,
      html.linkual-custom-fullscreen ytd-mini-guide-renderer,
      html.linkual-custom-fullscreen tp-yt-app-drawer {
        display: none !important;
      }
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active],
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] #player-container,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] ytd-player,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .html5-video-player {
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
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] {
        overflow: hidden !important;
        z-index: 2147483001 !important;
      }
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] #player-container,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] ytd-player,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .html5-video-player,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .html5-video-container,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .html5-video-player video {
        opacity: 1 !important;
        visibility: visible !important;
        z-index: 2147483002 !important;
      }
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .html5-video-container {
        position: absolute !important;
        inset: 0 !important;
        background: #000 !important;
      }
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .html5-video-player video {
        display: block !important;
        position: absolute !important;
      }
      html.linkual-custom-fullscreen ytd-reel-player-header-renderer,
      html.linkual-custom-fullscreen ytd-shorts-engagement-panel,
      html.linkual-custom-fullscreen ytd-engagement-panel-section-list-renderer,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] #scrubber,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] #actions,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] #menu,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .metadata-container,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .actions,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .pivot-button,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-chrome-top,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-chrome-bottom,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-gradient-top,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-gradient-bottom,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-pause-overlay,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-cards-teaser,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-ce-element,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-iv-player-content,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-player-content,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .ytp-caption-window-container {
        pointer-events: none !important;
        visibility: hidden !important;
      }
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .html5-video-container,
      html.linkual-custom-fullscreen ytd-reel-video-renderer[is-active] .html5-video-player video {
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
        ytd-app, #masthead-container { width: calc(100vw - var(--linkual-sidebar-width)) !important; max-width: calc(100vw - var(--linkual-sidebar-width)) !important; left: 0 !important; right: auto !important; margin-bottom: var(--linkual-universal-widget-height, 0px) !important; }
        ytd-shorts { width: calc(100vw - var(--linkual-sidebar-width)) !important; position: relative !important; }
        #shorts-container, #shorts-inner-container, ytd-reel-video-renderer { width: 100% !important; max-width: 100% !important; }
        ${customFullscreenCss}
      `;
    } else {
      styleEl.textContent = `
        html, body { overflow-x: hidden !important; }
        ytd-app, #masthead-container { width: 100vw !important; max-width: 100vw !important; left: 0 !important; right: auto !important; margin-bottom: calc(var(--linkual-sidebar-height) + var(--linkual-universal-widget-height, 0px)) !important; }
        ytd-shorts { height: calc(100vh - var(--linkual-sidebar-height) - var(--linkual-universal-widget-height, 0px)) !important; width: 100% !important; position: relative !important; }
        #shorts-container, #shorts-inner-container, ytd-reel-video-renderer { width: 100% !important; max-width: 100% !important; height: 100% !important; }
        ${customFullscreenCss}
      `;
    }

    if (this.resizeTimeout !== null) clearTimeout(this.resizeTimeout);
    this.resizeTimeout = window.setTimeout(() => {
      if (this.customFullscreenEnabled) {
        this.refreshCustomFullscreenLayout();
        this.resumeActiveVideoSoon();
      } else {
        this.restoreRegularPlayerLayout();
      }
    }, 150);
  }

  setCustomFullscreen(enabled: boolean) {
    const currentVideo = this.getVideoEl();
    this.resumeOnCustomFullscreen = enabled ? Boolean(currentVideo && !currentVideo.paused) : false;
    this.customFullscreenEnabled = enabled;
    if (enabled) {
      this.resumeActiveVideoSoon();
    }
    if (this.resizeTimeout !== null) clearTimeout(this.resizeTimeout);
    this.resizeTimeout = window.setTimeout(() => {
      if (enabled) {
        this.refreshCustomFullscreenLayout();
        this.resumeActiveVideoSoon();
      } else {
        this.restoreRegularPlayerLayout();
      }
    }, 150);
  }

  getCurrentTime() { return this.getVideoEl()?.currentTime || 0; }
  getDuration() { const duration = this.getVideoEl()?.duration || 0; return Number.isFinite(duration) ? duration : 0; }
  isPaused() { return this.getVideoEl()?.paused ?? true; }
  seekTo(time: number) {
    this.callPlayerMethod('seekTo', time, true);
    const v = this.getVideoEl();
    if (v) v.currentTime = time;
  }
  play() {
    this.resumeOnCustomFullscreen = true;
    this.playActiveVideo();
  }
  pause() {
    this.resumeOnCustomFullscreen = false;
    this.callPlayerMethod('pauseVideo');
    this.getVideoEl()?.pause();
  }
}
