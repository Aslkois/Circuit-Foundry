import type { ReactElement } from 'react';

/** Minimal stroke icons (24×24 viewBox) for the toolbar. */
const PATHS: Record<string, string> = {
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 000 11H13',
  rotate: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  select: 'M5 3l14 8-6 2-3 6z',
  wire: 'M4 18h6V6h10M4 18a1.5 1.5 0 100 .01M20 6a1.5 1.5 0 100 .01',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  tick: 'M3 17h4V7h5v10h5V7h4',
  step: 'M5 5l8 7-8 7zM16 5h3v14h-3z',
  reset: 'M4 12a8 8 0 108-8M4 4v6h6',
  zoomIn: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 114 2c-.9.6-1.5 1.2-1.5 2.5M12 17h.01',
  folder: 'M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  plus: 'M12 5v14M5 12h14',
  enter: 'M10 7l5 5-5 5M4 12h11M20 4v16',
  up: 'M12 19V5M6 11l6-6 6 6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  chip: 'M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  close: 'M6 6l12 12M18 6L6 18',
  warning: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  error: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9 9l6 6M15 9l-6 6',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 7h.01',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
