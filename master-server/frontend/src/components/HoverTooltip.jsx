import { useEffect, useState } from 'react';

const TOOLTIP_SELECTOR = '[data-tooltip]:not([data-tooltip=""])';
const TOOLTIP_MARGIN = 10;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const estimateTooltipWidth = (text, maxWidth) => {
  const length = Array.from(String(text || '')).length;
  return Math.min(maxWidth, Math.max(48, length * 12 + 18));
};

const resolveTooltipTarget = (target) => (
  target?.closest?.(TOOLTIP_SELECTOR) || null
);

const readTooltipText = (target) => (
  String(target?.getAttribute?.('data-tooltip') || target?.getAttribute?.('aria-label') || '').trim()
);

const calculatePosition = (target, text) => {
  if (!target || !text || typeof window === 'undefined') return null;
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const preferredTop = rect.top - TOOLTIP_MARGIN;
  const placeBelow = preferredTop < 32;
  const top = placeBelow ? rect.bottom + TOOLTIP_MARGIN : preferredTop;
  const maxWidth = Math.min(320, Math.max(160, window.innerWidth - 24));
  const estimatedWidth = estimateTooltipWidth(text, maxWidth);
  return {
    text,
    x: clamp(rect.left + rect.width / 2, 12 + estimatedWidth / 2, window.innerWidth - 12 - estimatedWidth / 2),
    y: placeBelow ? top : preferredTop,
    placement: placeBelow ? 'bottom' : 'top',
    maxWidth,
  };
};

export default function HoverTooltip() {
  const [tooltip, setTooltip] = useState(null);

  useEffect(() => {
    let currentTarget = null;
    let ignoreFocusUntil = 0;

    const showForTarget = (target) => {
      const tooltipTarget = resolveTooltipTarget(target);
      const text = readTooltipText(tooltipTarget);
      if (!tooltipTarget || !text) {
        currentTarget = null;
        setTooltip(null);
        return;
      }
      currentTarget = tooltipTarget;
      setTooltip(calculatePosition(tooltipTarget, text));
    };

    const hideTooltip = () => {
      currentTarget = null;
      setTooltip(null);
    };
    const handlePointerOver = (event) => {
      if (event.pointerType === 'touch') return;
      showForTarget(event.target);
    };
    const handleFocusIn = (event) => {
      if (Date.now() < ignoreFocusUntil) return;
      if (!event.target?.matches?.(':focus-visible')) return;
      showForTarget(event.target);
    };
    const handlePointerOut = (event) => {
      if (!currentTarget) return;
      const related = event.relatedTarget;
      if (related && currentTarget.contains(related)) return;
      hideTooltip();
    };
    const handleFocusOut = hideTooltip;
    const handlePointerDown = (event) => {
      if (event.pointerType === 'touch') {
        ignoreFocusUntil = Date.now() + 800;
      }
      hideTooltip();
    };
    const refreshPosition = () => {
      if (!currentTarget) return;
      setTooltip(calculatePosition(currentTarget, readTooltipText(currentTarget)));
    };

    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('pointerout', handlePointerOut, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true);
    window.addEventListener('scroll', refreshPosition, true);
    window.addEventListener('resize', refreshPosition);

    return () => {
      document.removeEventListener('pointerover', handlePointerOver, true);
      document.removeEventListener('pointerout', handlePointerOut, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('focusout', handleFocusOut, true);
      window.removeEventListener('scroll', refreshPosition, true);
      window.removeEventListener('resize', refreshPosition);
    };
  }, []);

  if (!tooltip) return null;

  return (
    <div
      className={`app-hover-tooltip is-${tooltip.placement}`}
      role="tooltip"
      style={{
        '--tooltip-x': `${tooltip.x}px`,
        '--tooltip-y': `${tooltip.y}px`,
        '--tooltip-max-width': `${tooltip.maxWidth}px`,
      }}
    >
      {tooltip.text}
    </div>
  );
}
