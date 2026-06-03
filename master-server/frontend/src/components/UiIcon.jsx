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
        <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v16H7.5A2.5 2.5 0 0 0 5 21.5z" />
        <path d="M5 5.5v16" />
        <path d="M9 7h7" />
        <path d="M9 10.5h5" />
        <path d="M8.2 16.2h8.5" />
      </svg>
    );
  }

  if (name === 'sliders') {
    return (
      <svg {...commonProps}>
        <path d="M4 6.5h4" />
        <path d="M12 6.5h8" />
        <circle cx="10" cy="6.5" r="2" />
        <path d="M4 17.5h9" />
        <path d="M17 17.5h3" />
        <circle cx="15" cy="17.5" r="2" />
      </svg>
    );
  }

  if (name === 'tune') {
    return (
      <svg {...commonProps}>
        <path d="M5 6.5h7" />
        <path d="M16 6.5h3" />
        <circle cx="14" cy="6.5" r="1.8" />
        <path d="M5 12h3" />
        <path d="M12 12h7" />
        <circle cx="10" cy="12" r="1.8" />
        <path d="M5 17.5h9" />
        <path d="M18 17.5h1" />
        <circle cx="16" cy="17.5" r="1.8" />
      </svg>
    );
  }

  if (name === 'wand') {
    return (
      <svg {...commonProps}>
        <path d="m5 19 9.5-9.5" />
        <path d="m13 8 3 3" />
        <path d="M17.5 3.8v2.8" />
        <path d="M16.1 5.2h2.8" />
        <path d="M7 4.8v2.4" />
        <path d="M5.8 6h2.4" />
        <path d="M19 15.8v2.4" />
        <path d="M17.8 17h2.4" />
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

  if (name === 'lock') {
    return (
      <svg {...commonProps}>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
        <path d="M12 14v2.5" />
      </svg>
    );
  }

  if (name === 'unlock') {
    return (
      <svg {...commonProps}>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7.5a4 4 0 0 1 7.4-2.1" />
        <path d="M12 14v2.5" />
      </svg>
    );
  }

  if (name === 'play') {
    return (
      <svg {...commonProps}>
        <path d="M8 5.5v13l11-6.5z" />
        <path d="M5 6.5v11" />
      </svg>
    );
  }

  if (name === 'shuffle') {
    return (
      <svg {...commonProps}>
        <path d="M4 7h2.2c2.2 0 3.3 1.1 4.6 3.2l2.4 3.6c1.3 2.1 2.4 3.2 4.6 3.2H20" />
        <path d="M17 14.5 20 17l-3 2.5" />
        <path d="M4 17h2.2c1.7 0 2.8-.7 3.8-2.2" />
        <path d="M13.5 8.8c1.1-1.2 2.2-1.8 4.3-1.8H20" />
        <path d="M17 4.5 20 7l-3 2.5" />
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
        <path d="M4.5 19.5h4.2L19 9.2a2 2 0 0 0-2.8-2.8L5.9 16.7z" />
        <path d="m14.8 7.8 2.8 2.8" />
        <path d="M4.5 19.5 5.9 16.7" />
      </svg>
    );
  }

  if (name === 'filter') {
    return (
      <svg {...commonProps}>
        <path d="M4.5 5.5h15" />
        <path d="m8.5 10 3.5 3.8V19l4-2v-3.2L19.5 10" />
        <path d="M7 10h10" />
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

  if (name === 'todo') {
    return (
      <svg {...commonProps}>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="m8 9 1.7 1.7L13 7.5" />
        <path d="M15 9.5h2" />
        <path d="m8 15 1.7 1.7L13 13.5" />
        <path d="M15 15.5h2" />
      </svg>
    );
  }

  if (name === 'target') {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2.5v3" />
        <path d="M12 18.5v3" />
        <path d="M2.5 12h3" />
        <path d="M18.5 12h3" />
        <path d="m15 9 4-4" />
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
        <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
        <path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" />
      </svg>
    );
  }

  if (name === 'external-link') {
    return (
      <svg {...commonProps}>
        <path d="M14 4h6v6" />
        <path d="m20 4-8.5 8.5" />
        <path d="M11 6H6.5A2.5 2.5 0 0 0 4 8.5v9A2.5 2.5 0 0 0 6.5 20h9a2.5 2.5 0 0 0 2.5-2.5V13" />
        <path d="M8 13.5h5" />
      </svg>
    );
  }

  if (name === 'fullscreen') {
    return (
      <svg {...commonProps}>
        <path d="M8.5 4H4v4.5" />
        <path d="M4 4 9.2 9.2" />
        <path d="M15.5 4H20v4.5" />
        <path d="M20 4 14.8 9.2" />
        <path d="M8.5 20H4v-4.5" />
        <path d="M4 20 9.2 14.8" />
        <path d="M15.5 20H20v-4.5" />
        <path d="M20 20 14.8 14.8" />
      </svg>
    );
  }

  if (name === 'fullscreen-exit') {
    return (
      <svg {...commonProps}>
        <path d="M9 4.5V9H4.5" />
        <path d="M9 9 4 4" />
        <path d="M15 4.5V9h4.5" />
        <path d="m15 9 5-5" />
        <path d="M9 19.5V15H4.5" />
        <path d="m9 15-5 5" />
        <path d="M15 19.5V15h4.5" />
        <path d="m15 15 5 5" />
      </svg>
    );
  }

  if (name === 'dictionary-link') {
    return (
      <svg {...commonProps}>
        <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H18v14.5H7.5A2.5 2.5 0 0 0 5 20z" />
        <path d="M5 5.5V20" />
        <path d="M8.5 7h5" />
        <path d="M8.5 10h3.5" />
        <path d="M14 14h5v5" />
        <path d="m19 14-6 6" />
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

  if (name === 'chart') {
    return (
      <svg {...commonProps}>
        <path d="M4 20V5" />
        <path d="M4 20h16" />
        <path d="M8 16v-5" />
        <path d="M12 16V8" />
        <path d="M16 16v-9" />
      </svg>
    );
  }

  if (name === 'pie') {
    return (
      <svg {...commonProps}>
        <path d="M12 3v9h9" />
        <path d="M20.5 14.5A8.7 8.7 0 1 1 9.5 3.5" />
        <path d="M14 3.3A8.7 8.7 0 0 1 20.7 10H14z" />
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
