import React, { useEffect, useRef, useState } from 'react';
import { IVideoAdapter } from '../adapters/BaseAdapter';

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

const DRAG_THRESHOLD = 5;
const FULLSCREEN_SETTLE_DELAY = 180;
const SEEK_STEP_SECONDS = 5;
const USER_AGENT = navigator.userAgent.toLowerCase();
const IS_ANDROID = USER_AGENT.includes('android');
const IS_MOBILE_EDGE = IS_ANDROID && USER_AGENT.includes('edg');

function getBrowserFullscreenElement() {
  const doc = document as FullscreenDocument;
  return document.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement ||
    null;
}

function requestBrowserFullscreen() {
  const target = document.documentElement as FullscreenElement;

  if (target.requestFullscreen) return target.requestFullscreen();
  if (target.webkitRequestFullscreen) return target.webkitRequestFullscreen();
  if (target.mozRequestFullScreen) return target.mozRequestFullScreen();
  if (target.msRequestFullscreen) return target.msRequestFullscreen();
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
}

function emitCustomLayoutChange() {
  syncMobileViewportVars();
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
  const [fullscreen, setFullscreen] = useState(() => document.documentElement.classList.contains('linkual-custom-fullscreen'));
  const [position, setPosition] = useState<ButtonPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const progressRef = useRef<HTMLInputElement | null>(null);
  const fullscreenRequestPendingRef = useRef(false);
  const browserFullscreenFallbackRef = useRef(false);
  const dragRef = useRef({
    pointerId: -1,
    offsetX: 0,
    offsetY: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });

  const applyCustomFullscreenState = (enabled: boolean) => {
    syncMobileViewportVars();
    document.documentElement.classList.toggle('linkual-custom-fullscreen', enabled);
    document.documentElement.classList.toggle('linkual-mobile-fullscreen-fallback', enabled && browserFullscreenFallbackRef.current);
    adapter.setCustomFullscreen?.(enabled);
    setFullscreen(enabled);
    emitCustomLayoutChange();
  };

  useEffect(() => {
    const syncFullscreenState = () => {
      const customFullscreen = document.documentElement.classList.contains('linkual-custom-fullscreen');
      if (
        customFullscreen &&
        !getBrowserFullscreenElement() &&
        !browserFullscreenFallbackRef.current &&
        !fullscreenRequestPendingRef.current
      ) {
        document.documentElement.classList.remove('linkual-custom-fullscreen');
        adapter.setCustomFullscreen?.(false);
        emitCustomLayoutChange();
        setFullscreen(false);
        return;
      }

      setFullscreen(customFullscreen);
    };

    window.addEventListener('linkual_custom_fullscreen_changed', syncFullscreenState);
    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);
    document.addEventListener('mozfullscreenchange', syncFullscreenState);
    document.addEventListener('MSFullscreenChange', syncFullscreenState);

    return () => {
      window.removeEventListener('linkual_custom_fullscreen_changed', syncFullscreenState);
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState);
      document.removeEventListener('mozfullscreenchange', syncFullscreenState);
      document.removeEventListener('MSFullscreenChange', syncFullscreenState);
    };
  }, [adapter]);

  useEffect(() => {
    adapter.setCustomFullscreen?.(fullscreen);
    window.dispatchEvent(new Event('linkual_custom_layout_refresh'));
    window.dispatchEvent(new Event('resize'));
  }, [adapter, fullscreen]);

  useEffect(() => () => {
    const hadCustomFullscreen = document.documentElement.classList.contains('linkual-custom-fullscreen');
    fullscreenRequestPendingRef.current = false;

    if (!hadCustomFullscreen) return;

    document.documentElement.classList.remove('linkual-custom-fullscreen');
    document.documentElement.classList.remove('linkual-mobile-fullscreen-fallback');
    adapter.setCustomFullscreen?.(false);
    emitCustomLayoutChange();

    if (getBrowserFullscreenElement() === document.documentElement) {
      const browserFullscreenAction = exitBrowserFullscreen();
      if (isPromiseLike(browserFullscreenAction)) {
        browserFullscreenAction.catch((error) => console.warn('[Linkual] 浏览器全屏退出失败', error));
      }
    }
  }, [adapter]);

  useEffect(() => {
    const syncViewport = () => {
      if (fullscreen) emitCustomLayoutChange();
      else syncMobileViewportVars();
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

  const exitCustomFullscreen = () => {
    browserFullscreenFallbackRef.current = false;
    applyCustomFullscreenState(false);
    document.documentElement.classList.remove('linkual-mobile-fullscreen-fallback');
    const browserFullscreenAction = getBrowserFullscreenElement() ? exitBrowserFullscreen() : undefined;
    if (isPromiseLike(browserFullscreenAction)) {
      browserFullscreenAction.catch((error) => console.warn('[Linkual] 浏览器全屏切换失败', error));
    }
  };

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (dragRef.current.moved) {
      event.preventDefault();
      event.stopPropagation();
      dragRef.current.moved = false;
      return;
    }

    const nextFullscreen = !fullscreen;
    fullscreenRequestPendingRef.current = nextFullscreen;
    browserFullscreenFallbackRef.current = false;
    applyCustomFullscreenState(nextFullscreen);

    if (nextFullscreen) {
      if (IS_MOBILE_EDGE) {
        browserFullscreenFallbackRef.current = true;
        document.documentElement.classList.add('linkual-mobile-fullscreen-fallback');
        window.setTimeout(() => {
          fullscreenRequestPendingRef.current = false;
          emitCustomLayoutChange();
        }, FULLSCREEN_SETTLE_DELAY);
        return;
      }

      const browserFullscreenAction = requestBrowserFullscreen();
      const finishPending = () => {
        window.setTimeout(() => {
          fullscreenRequestPendingRef.current = false;
          browserFullscreenFallbackRef.current = !getBrowserFullscreenElement();
          document.documentElement.classList.toggle('linkual-mobile-fullscreen-fallback', browserFullscreenFallbackRef.current);
          emitCustomLayoutChange();
        }, FULLSCREEN_SETTLE_DELAY);
      };

      if (isPromiseLike(browserFullscreenAction)) {
        browserFullscreenAction.then(finishPending).catch((error) => {
          console.warn('[Linkual] 浏览器全屏切换失败', error);
          browserFullscreenFallbackRef.current = true;
          document.documentElement.classList.add('linkual-mobile-fullscreen-fallback');
          finishPending();
        });
      } else {
        finishPending();
      }
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
  }, [adapter, duration, fullscreen, paused]);

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
          进入全屏
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
              -5
            </button>
            <button type="button" className="linkual-player-btn primary" onClick={togglePlayback} title={paused ? '播放' : '暂停'}>
              {paused ? '播放' : '暂停'}
            </button>
            <button type="button" className="linkual-player-btn" onClick={() => seekBy(SEEK_STEP_SECONDS)} title="前进 5 秒">
              +5
            </button>
            <button type="button" className="linkual-player-btn" onClick={exitCustomFullscreen} title="退出全屏">
              退出
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default MobileFullscreenButton;
