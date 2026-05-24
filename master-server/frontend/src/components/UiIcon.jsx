export default function UiIcon({ name, size = 18 }) {
  const commonProps = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };

  if (name === 'upload') {
    return (
      <svg {...commonProps}>
        <path d="M12 15V4" />
        <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
        <path d="M5 15v3.2c0 .5.2.9.5 1.3.4.3.8.5 1.3.5h10.4c.5 0 .9-.2 1.3-.5.3-.4.5-.8.5-1.3V15" />
      </svg>
    );
  }

  if (name === 'image') {
    return (
      <svg {...commonProps}>
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.4" />
        <path d="m7 17 4.2-4.2c.4-.4 1-.4 1.4 0L17 17" />
      </svg>
    );
  }

  if (name === 'file') {
    return (
      <svg {...commonProps}>
        <path d="M7 3.5h6l4 4V20H7z" />
        <path d="M13 3.5V8h4" />
        <path d="M9.5 12h5" />
        <path d="M9.5 15h5" />
      </svg>
    );
  }

  if (name === 'folder') {
    return (
      <svg {...commonProps}>
        <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" />
      </svg>
    );
  }

  if (name === 'check') {
    return (
      <svg {...commonProps}>
        <path d="m5 12.5 4 4L19 6.5" />
      </svg>
    );
  }

  if (name === 'book') {
    return (
      <svg {...commonProps}>
        <path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h12.5v16H7a2.5 2.5 0 0 0-2.5 2.5z" />
        <path d="M4.5 5.5v16" />
        <path d="M8 7h7" />
        <path d="M8 10h5" />
      </svg>
    );
  }

  if (name === 'sliders') {
    return (
      <svg {...commonProps}>
        <path d="M4 7h7" />
        <path d="M15 7h5" />
        <path d="M13 5v4" />
        <path d="M4 17h5" />
        <path d="M13 17h7" />
        <path d="M11 15v4" />
      </svg>
    );
  }

  if (name === 'settings') {
    return (
      <svg {...commonProps}>
        <path d="M12 15.2A3.2 3.2 0 1 0 12 8.8a3.2 3.2 0 0 0 0 6.4Z" />
        <path d="M18.4 15.3c.2.4.1.9-.2 1.2l-1 1c-.3.3-.8.4-1.2.2l-1-.4c-.4.2-.8.4-1.2.5l-.4 1c-.2.4-.5.7-1 .7h-1.4c-.5 0-.8-.3-1-.7l-.4-1c-.4-.1-.8-.3-1.2-.5l-1 .4c-.4.2-.9.1-1.2-.2l-1-1c-.3-.3-.4-.8-.2-1.2l.4-1c-.2-.4-.4-.8-.5-1.2l-1-.4c-.4-.2-.7-.5-.7-1v-1.4c0-.5.3-.8.7-1l1-.4c.1-.4.3-.8.5-1.2l-.4-1c-.2-.4-.1-.9.2-1.2l1-1c.3-.3.8-.4 1.2-.2l1 .4c.4-.2.8-.4 1.2-.5l.4-1c.2-.4.5-.7 1-.7h1.4c.5 0 .8.3 1 .7l.4 1c.4.1.8.3 1.2.5l1-.4c.4-.2.9-.1 1.2.2l1 1c.3.3.4.8.2 1.2l-.4 1c.2.4.4.8.5 1.2l1 .4c.4.2.7.5.7 1v1.4c0 .5-.3.8-.7 1l-1 .4c-.1.4-.3.8-.5 1.2z" />
      </svg>
    );
  }

  if (name === 'refresh') {
    return (
      <svg {...commonProps}>
        <path d="M20 12a8 8 0 0 1-13.7 5.6" />
        <path d="M4 12A8 8 0 0 1 17.7 6.4" />
        <path d="M17 3.5v3.2h3.2" />
        <path d="M7 20.5v-3.2H3.8" />
      </svg>
    );
  }

  if (name === 'trash') {
    return (
      <svg {...commonProps}>
        <path d="M4.5 7h15" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M6.5 7 7.3 20h9.4l.8-13" />
        <path d="M9 7V4.5h6V7" />
      </svg>
    );
  }

  if (name === 'save') {
    return (
      <svg {...commonProps}>
        <path d="M5 4h12l2 2v14H5z" />
        <path d="M8 4v6h8V4" />
        <path d="M8 20v-6h8v6" />
      </svg>
    );
  }

  if (name === 'play') {
    return (
      <svg {...commonProps}>
        <path d="M8 5.5v13l11-6.5z" />
      </svg>
    );
  }

  if (name === 'chevron-left') {
    return (
      <svg {...commonProps}>
        <path d="m15 18-6-6 6-6" />
      </svg>
    );
  }

  if (name === 'chevron-up') {
    return (
      <svg {...commonProps}>
        <path d="m6 15 6-6 6 6" />
      </svg>
    );
  }

  if (name === 'chevron-down') {
    return (
      <svg {...commonProps}>
        <path d="m6 9 6 6 6-6" />
      </svg>
    );
  }

  if (name === 'list') {
    return (
      <svg {...commonProps}>
        <path d="M8 6h12" />
        <path d="M8 12h12" />
        <path d="M8 18h12" />
        <path d="M4 6h.01" />
        <path d="M4 12h.01" />
        <path d="M4 18h.01" />
      </svg>
    );
  }

  if (name === 'edit') {
    return (
      <svg {...commonProps}>
        <path d="M4 20h4l11-11a2.1 2.1 0 0 0-3-3L5 17z" />
        <path d="m14 7 3 3" />
      </svg>
    );
  }

  if (name === 'filter') {
    return (
      <svg {...commonProps}>
        <path d="M4 5h16" />
        <path d="M7 12h10" />
        <path d="M10 19h4" />
      </svg>
    );
  }

  if (name === 'calendar') {
    return (
      <svg {...commonProps}>
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M8 3.5v3" />
        <path d="M16 3.5v3" />
        <path d="M4 9h16" />
        <path d="M8 13h.01" />
        <path d="M12 13h.01" />
        <path d="M16 13h.01" />
      </svg>
    );
  }

  if (name === 'target') {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="7.5" />
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2.8v3" />
        <path d="M12 18.2v3" />
        <path d="M2.8 12h3" />
        <path d="M18.2 12h3" />
      </svg>
    );
  }

  if (name === 'search') {
    return (
      <svg {...commonProps}>
        <circle cx="11" cy="11" r="6" />
        <path d="m16 16 4 4" />
      </svg>
    );
  }

  if (name === 'volume') {
    return (
      <svg {...commonProps}>
        <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5z" />
        <path d="M16 9a4 4 0 0 1 0 6" />
        <path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" />
      </svg>
    );
  }

  if (name === 'external-link') {
    return (
      <svg {...commonProps}>
        <path d="M14 4h6v6" />
        <path d="m20 4-9 9" />
        <path d="M11 6H6.5A2.5 2.5 0 0 0 4 8.5v9A2.5 2.5 0 0 0 6.5 20h9a2.5 2.5 0 0 0 2.5-2.5V13" />
      </svg>
    );
  }

  if (name === 'star') {
    return (
      <svg {...commonProps}>
        <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2l-5.6 3 1.1-6.2L3 9.6l6.2-.9z" />
      </svg>
    );
  }

  if (name === 'info') {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11.5V16" />
        <path d="M12 8h.01" />
      </svg>
    );
  }

  if (name === 'clock') {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
    );
  }

  if (name === 'trending-up') {
    return (
      <svg {...commonProps}>
        <path d="M4 17h16" />
        <path d="m5 14 4.5-4.5 3.5 3.5L19 7" />
        <path d="M15.5 7H19v3.5" />
      </svg>
    );
  }

  if (name === 'history') {
    return (
      <svg {...commonProps}>
        <path d="M4 12a8 8 0 1 0 2.3-5.7" />
        <path d="M4 5.5v4h4" />
        <path d="M12 8v4l2.5 1.5" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
