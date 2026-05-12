import React, { useEffect, useRef, useState } from 'react';

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

function getFullscreenElement() {
  const doc = document as FullscreenDocument;
  return document.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement ||
    null;
}

function isFullscreen() {
  return getFullscreenElement() !== null;
}

function requestFullscreen() {
  const target = document.documentElement as FullscreenElement;

  if (target.requestFullscreen) return target.requestFullscreen();
  if (target.webkitRequestFullscreen) return target.webkitRequestFullscreen();
  if (target.mozRequestFullScreen) return target.mozRequestFullScreen();
  if (target.msRequestFullscreen) return target.msRequestFullscreen();
}

function exitFullscreen() {
  const doc = document as FullscreenDocument;

  if (document.exitFullscreen) return document.exitFullscreen();
  if (doc.webkitExitFullscreen) return doc.webkitExitFullscreen();
  if (doc.mozCancelFullScreen) return doc.mozCancelFullScreen();
  if (doc.msExitFullscreen) return doc.msExitFullscreen();
}

function clampPosition(left: number, top: number, element: HTMLElement) {
  const maxLeft = Math.max(0, window.innerWidth - element.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - element.offsetHeight);

  return {
    left: Math.min(Math.max(0, left), maxLeft),
    top: Math.min(Math.max(0, top), maxTop),
  };
}

const MobileFullscreenButton: React.FC = () => {
  const [fullscreen, setFullscreen] = useState(isFullscreen);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef({
    pointerId: -1,
    offsetX: 0,
    offsetY: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });

  useEffect(() => {
    const syncFullscreenState = () => setFullscreen(isFullscreen());

    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);
    document.addEventListener('mozfullscreenchange', syncFullscreenState);
    document.addEventListener('MSFullscreenChange', syncFullscreenState);

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState);
      document.removeEventListener('mozfullscreenchange', syncFullscreenState);
      document.removeEventListener('MSFullscreenChange', syncFullscreenState);
    };
  }, []);

  useEffect(() => {
    if (!position) return;

    const keepButtonInView = () => {
      const button = buttonRef.current;
      if (!button) return;
      setPosition((current) => current ? clampPosition(current.left, current.top, button) : current);
    };

    window.addEventListener('resize', keepButtonInView);
    window.addEventListener('orientationchange', keepButtonInView);

    return () => {
      window.removeEventListener('resize', keepButtonInView);
      window.removeEventListener('orientationchange', keepButtonInView);
    };
  }, [position]);

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
    setPosition({ left: rect.left, top: rect.top });
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

    setPosition(clampPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY, button));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const drag = dragRef.current;

    if (event.pointerId === drag.pointerId && button.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }

    setDragging(false);
  };

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (dragRef.current.moved) {
      event.preventDefault();
      event.stopPropagation();
      dragRef.current.moved = false;
      return;
    }

    const result = fullscreen ? exitFullscreen() : requestFullscreen();
    if (result instanceof Promise) {
      result.catch((error) => console.warn('[Linkual] 全屏切换失败', error));
    }
  };

  const style: React.CSSProperties = position
    ? {
        left: position.left,
        top: position.top,
        right: 'auto',
        bottom: 'auto',
      }
    : {};

  return (
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
      {fullscreen ? '退出全屏' : '进入全屏'}
    </button>
  );
};

export default MobileFullscreenButton;
