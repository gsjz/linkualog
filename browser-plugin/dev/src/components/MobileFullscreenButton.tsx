import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import { IVideoAdapter } from '../adapters/BaseAdapter';

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
};

const DRAG_THRESHOLD = 5;
const SEEK_STEP_SECONDS = 5;
const LINKUAL_CUSTOM_FULLSCREEN_CLASS = 'linkual-custom-fullscreen';
const LINKUAL_MOBILE_FULLSCREEN_FALLBACK_CLASS = 'linkual-mobile-fullscreen-fallback';

function getBrowserFullscreenElement() {
  const doc = document as FullscreenDocument;
  return document.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement ||
    null;
}

function exitBrowserFullscreen() {
  const doc = document as FullscreenDocument;

  if (document.exitFullscreen) return document.exitFullscreen();
  if (doc.webkitExitFullscreen) return doc.webkitExitFullscreen();
  if (doc.mozCancelFullScreen) return doc.mozCancelFullScreen();
  if (doc.msExitFullscreen) return doc.msExitFullscreen();
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return Boolean(value && typeof (value as Promise<void>).then === 'function');
}

function getViewportSize() {
  const width = window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth;
  const height = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;

  return {
    width: Number.isFinite(width) && width > 0 ? width : window.innerWidth,
    height: Number.isFinite(height) && height > 0 ? height : window.innerHeight,
  };
}

function syncMobileViewportVars() {
  const viewport = getViewportSize();
  document.documentElement.style.setProperty('--linkual-mobile-viewport-width', `${Math.ceil(viewport.width)}px`);
  document.documentElement.style.setProperty('--linkual-mobile-viewport-height', `${Math.ceil(viewport.height)}px`);
  document.documentElement.style.setProperty('--linkual-visual-viewport-height', `${Math.ceil(viewport.height)}px`);

  const root = document.getElementById('linkual-root');
  root?.style.setProperty('--linkual-visual-viewport-height', `${Math.ceil(viewport.height)}px`);
}

function emitCustomLayoutChange() {
  syncMobileViewportVars();
  window.dispatchEvent(new Event('linkual_root_recover'));
  window.dispatchEvent(new Event('linkual_custom_layout_refresh'));
  window.dispatchEvent(new Event('linkual_custom_fullscreen_changed'));
  window.dispatchEvent(new Event('resize'));
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function clampPosition(left: number, top: number, element: HTMLElement) {
  const viewport = getViewportSize();
  const maxLeft = Math.max(0, viewport.width - element.offsetWidth);
  const maxTop = Math.max(0, viewport.height - element.offsetHeight);

  return {
    left: Math.min(Math.max(0, left), maxLeft),
    top: Math.min(Math.max(0, top), maxTop),
  };
}

function getPositionRatios(left: number, top: number, element: HTMLElement) {
  const viewport = getViewportSize();
  const maxLeft = Math.max(0, viewport.width - element.offsetWidth);
  const maxTop = Math.max(0, viewport.height - element.offsetHeight);

  return {
    ratioX: maxLeft > 0 ? left / maxLeft : 0,
    ratioY: maxTop > 0 ? top / maxTop : 0,
  };
}

function createPosition(left: number, top: number, element: HTMLElement) {
  const clamped = clampPosition(left, top, element);
  const ratios = getPositionRatios(clamped.left, clamped.top, element);
  return { ...clamped, ...ratios };
}

function createPositionFromRatios(ratioX: number, ratioY: number, element: HTMLElement) {
  const viewport = getViewportSize();
  const maxLeft = Math.max(0, viewport.width - element.offsetWidth);
  const maxTop = Math.max(0, viewport.height - element.offsetHeight);
  return createPosition(ratioX * maxLeft, ratioY * maxTop, element);
}

interface MobileFullscreenButtonProps {
  adapter: IVideoAdapter;
}

interface ButtonPosition {
  left: number;
  top: number;
  ratioX: number;
  ratioY: number;
}

const MobileFullscreenButton: React.FC<MobileFullscreenButtonProps> = ({ adapter }) => {
  const [fullscreen, setFullscreen] = useState(() => document.documentElement.classList.contains(LINKUAL_CUSTOM_FULLSCREEN_CLASS));
  const [position, setPosition] = useState<ButtonPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const progressRef = useRef<HTMLInputElement | null>(null);
  const browserFullscreenWasActiveRef = useRef(Boolean(getBrowserFullscreenElement()));
  const dragRef = useRef({
    pointerId: -1,
    offsetX: 0,
    offsetY: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });

  const setAdapterCustomFullscreen = useCallback((enabled: boolean) => {
    try {
      adapter.setCustomFullscreen?.(enabled);
    } catch (error) {
      console.warn('[Linkual] 自定义全屏状态同步失败', error);
    }
  }, [adapter]);

  const applyCustomFullscreenState = useCallback((enabled: boolean) => {
    browserFullscreenWasActiveRef.current = enabled && Boolean(getBrowserFullscreenElement());
    document.documentElement.classList.toggle(LINKUAL_CUSTOM_FULLSCREEN_CLASS, enabled);
    setAdapterCustomFullscreen(enabled);
    setFullscreen(enabled);
    emitCustomLayoutChange();
  }, [setAdapterCustomFullscreen]);

  const clearCustomFullscreenState = useCallback(() => {
    const hadCustomFullscreen = document.documentElement.classList.contains(LINKUAL_CUSTOM_FULLSCREEN_CLASS);
    browserFullscreenWasActiveRef.current = false;

    if (!hadCustomFullscreen) {
      document.documentElement.classList.remove(LINKUAL_MOBILE_FULLSCREEN_FALLBACK_CLASS);
      setFullscreen(false);
      return;
    }

    document.documentElement.classList.remove(LINKUAL_CUSTOM_FULLSCREEN_CLASS);
    document.documentElement.classList.remove(LINKUAL_MOBILE_FULLSCREEN_FALLBACK_CLASS);
    setAdapterCustomFullscreen(false);
    setFullscreen(false);
    emitCustomLayoutChange();
  }, [setAdapterCustomFullscreen]);

  useEffect(() => {
    const syncFullscreenState = () => {
      setFullscreen(document.documentElement.classList.contains(LINKUAL_CUSTOM_FULLSCREEN_CLASS));
    };

    const clearStaleCustomFullscreen = () => {
      const browserFullscreenElement = getBrowserFullscreenElement();

      if (browserFullscreenElement) {
        browserFullscreenWasActiveRef.current = true;
        return;
      }

      if (browserFullscreenWasActiveRef.current && document.documentElement.classList.contains(LINKUAL_CUSTOM_FULLSCREEN_CLASS)) {
        clearCustomFullscreenState();
        return;
      }

      browserFullscreenWasActiveRef.current = false;
      syncFullscreenState();
    };

    window.addEventListener('linkual_custom_fullscreen_changed', syncFullscreenState);
    document.addEventListener('fullscreenchange', clearStaleCustomFullscreen);
    document.addEventListener('webkitfullscreenchange', clearStaleCustomFullscreen);
    document.addEventListener('mozfullscreenchange', clearStaleCustomFullscreen);
    document.addEventListener('MSFullscreenChange', clearStaleCustomFullscreen);

    return () => {
      window.removeEventListener('linkual_custom_fullscreen_changed', syncFullscreenState);
      document.removeEventListener('fullscreenchange', clearStaleCustomFullscreen);
      document.removeEventListener('webkitfullscreenchange', clearStaleCustomFullscreen);
      document.removeEventListener('mozfullscreenchange', clearStaleCustomFullscreen);
      document.removeEventListener('MSFullscreenChange', clearStaleCustomFullscreen);
    };
  }, [clearCustomFullscreenState]);

  useEffect(() => {
    setAdapterCustomFullscreen(fullscreen);
    window.dispatchEvent(new Event('linkual_custom_layout_refresh'));
    window.dispatchEvent(new Event('resize'));
  }, [fullscreen, setAdapterCustomFullscreen]);

  useEffect(() => () => {
    const hadCustomFullscreen = document.documentElement.classList.contains(LINKUAL_CUSTOM_FULLSCREEN_CLASS);
    browserFullscreenWasActiveRef.current = false;

    if (!hadCustomFullscreen) return;

    document.documentElement.classList.remove(LINKUAL_CUSTOM_FULLSCREEN_CLASS);
    document.documentElement.classList.remove(LINKUAL_MOBILE_FULLSCREEN_FALLBACK_CLASS);
    setAdapterCustomFullscreen(false);
    emitCustomLayoutChange();

    if (getBrowserFullscreenElement()) {
      const browserFullscreenAction = exitBrowserFullscreen();
      if (isPromiseLike(browserFullscreenAction)) {
        browserFullscreenAction.catch((error) => console.warn('[Linkual] 浏览器全屏退出失败', error));
      }
    }
  }, [setAdapterCustomFullscreen]);

  useEffect(() => {
    const syncViewport = () => {
      syncMobileViewportVars();
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);
    window.visualViewport?.addEventListener('resize', syncViewport);
    window.visualViewport?.addEventListener('scroll', syncViewport);

    return () => {
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      window.visualViewport?.removeEventListener('resize', syncViewport);
      window.visualViewport?.removeEventListener('scroll', syncViewport);
    };
  }, [fullscreen]);

  useEffect(() => {
    if (!position) return;

    const keepButtonInView = () => {
      const button = buttonRef.current;
      if (!button) return;
      setPosition((current) => current ? createPositionFromRatios(current.ratioX, current.ratioY, button) : current);
    };

    window.addEventListener('resize', keepButtonInView);
    window.addEventListener('orientationchange', keepButtonInView);
    window.visualViewport?.addEventListener('resize', keepButtonInView);

    return () => {
      window.removeEventListener('resize', keepButtonInView);
      window.removeEventListener('orientationchange', keepButtonInView);
      window.visualViewport?.removeEventListener('resize', keepButtonInView);
    };
  }, [position]);

  useEffect(() => {
    if (!fullscreen) return undefined;

    let frameId = 0;
    const syncPlaybackState = () => {
      const nextCurrentTime = adapter.getCurrentTime();
      const nextDuration = adapter.getDuration?.() || 0;

      setCurrentTime(Number.isFinite(nextCurrentTime) ? nextCurrentTime : 0);
      setDuration(Number.isFinite(nextDuration) ? nextDuration : 0);
      setPaused(adapter.isPaused?.() ?? false);
      frameId = window.requestAnimationFrame(syncPlaybackState);
    };

    syncPlaybackState();
    return () => window.cancelAnimationFrame(frameId);
  }, [adapter, fullscreen]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();

    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };

    button.setPointerCapture(event.pointerId);
    setPosition(createPosition(rect.left, rect.top, button));
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const button = buttonRef.current;
    const drag = dragRef.current;

    if (!dragging || !button || event.pointerId !== drag.pointerId) return;

    const dx = Math.abs(event.clientX - drag.startX);
    const dy = Math.abs(event.clientY - drag.startY);
    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
      drag.moved = true;
    }

    setPosition(createPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY, button));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const drag = dragRef.current;

    if (event.pointerId === drag.pointerId && button.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }

    setDragging(false);
  };

  const exitCustomFullscreen = useCallback(() => {
    const browserFullscreenElement = getBrowserFullscreenElement();
    clearCustomFullscreenState();
    const browserFullscreenAction = browserFullscreenElement ? exitBrowserFullscreen() : undefined;
    if (isPromiseLike(browserFullscreenAction)) {
      browserFullscreenAction.catch((error) => console.warn('[Linkual] 浏览器全屏切换失败', error));
    }
  }, [clearCustomFullscreenState]);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (dragRef.current.moved) {
      event.preventDefault();
      event.stopPropagation();
      dragRef.current.moved = false;
      return;
    }

    const nextFullscreen = !fullscreen;
    if (nextFullscreen) {
      applyCustomFullscreenState(true);
      return;
    }

    exitCustomFullscreen();
  };

  const togglePlayback = () => {
    if (adapter.isPaused?.() ?? paused) {
      adapter.play();
    } else {
      adapter.pause();
    }
  };

  const seekBy = (delta: number) => {
    const nextTime = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, adapter.getCurrentTime() + delta));
    adapter.seekTo(nextTime);
  };

  const handleProgressInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(event.currentTarget.value);
    if (!Number.isFinite(nextTime)) return;
    adapter.seekTo(nextTime);
    setCurrentTime(nextTime);
  };

  const handleProgressPointerDown = () => {
    progressRef.current?.focus();
  };

  useEffect(() => {
    if (!fullscreen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing = Boolean(target?.closest('input, textarea, select, [contenteditable]'));
      if (isEditing) return;

      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        seekBy(-SEEK_STEP_SECONDS);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        seekBy(SEEK_STEP_SECONDS);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        exitCustomFullscreen();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [adapter, duration, exitCustomFullscreen, fullscreen, paused]);

  const style: React.CSSProperties = position
    ? {
        left: position.left,
        top: position.top,
        right: 'auto',
        bottom: 'auto',
      }
    : {};

  const progressPercent = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;

  return (
    <>
      {!fullscreen && (
        <button
          ref={buttonRef}
          type="button"
          className={`linkual-mobile-fullscreen ${dragging ? 'is-dragging' : ''}`}
          style={style}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={handleClick}
        >
          <Maximize2 className="linkual-mobile-fullscreen-icon" size={15} strokeWidth={2.2} />
          <span>进入全屏</span>
        </button>
      )}

      {fullscreen && (
        <div className="linkual-player-controls">
          <div className="linkual-player-progress-row">
            <span className="linkual-player-time">{formatTime(currentTime)}</span>
            <input
              ref={progressRef}
              className="linkual-player-progress"
              type="range"
              min="0"
              max={Math.max(1, duration)}
              step="0.1"
              value={Math.min(currentTime, Math.max(1, duration))}
              onChange={handleProgressInput}
              onPointerDown={handleProgressPointerDown}
              style={{
                '--linkual-progress': `${progressPercent}%`,
              } as React.CSSProperties}
              aria-label="播放进度"
            />
            <span className="linkual-player-time">{formatTime(duration)}</span>
          </div>
          <div className="linkual-player-button-row">
            <button type="button" className="linkual-player-btn" onClick={() => seekBy(-SEEK_STEP_SECONDS)} title="后退 5 秒">
              <RotateCcw className="linkual-player-btn-icon" size={15} strokeWidth={2.2} />
              <span>5s</span>
            </button>
            <button type="button" className="linkual-player-btn primary" onClick={togglePlayback} title={paused ? '播放' : '暂停'}>
              {paused ? (
                <Play className="linkual-player-btn-icon" size={15} strokeWidth={2.2} />
              ) : (
                <Pause className="linkual-player-btn-icon" size={15} strokeWidth={2.2} />
              )}
              <span>{paused ? '播放' : '暂停'}</span>
            </button>
            <button type="button" className="linkual-player-btn" onClick={() => seekBy(SEEK_STEP_SECONDS)} title="前进 5 秒">
              <RotateCw className="linkual-player-btn-icon" size={15} strokeWidth={2.2} />
              <span>5s</span>
            </button>
            <button type="button" className="linkual-player-btn" onClick={exitCustomFullscreen} title="退出全屏">
              <Minimize2 className="linkual-player-btn-icon" size={15} strokeWidth={2.2} />
              <span>退出</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default MobileFullscreenButton;
