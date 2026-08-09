const PATHS = {
  spark: <><path d="M12 2.75 13.85 8.15 19.25 10l-5.4 1.85L12 17.25l-1.85-5.4L4.75 10l5.4-1.85L12 2.75Z" /><path d="m19.5 15 .75 2.25L22.5 18l-2.25.75L19.5 21l-.75-2.25L16.5 18l2.25-.75L19.5 15Z" /></>,
  message: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 7.9 7.9 0 0 1-3.1-.63L4 20l1.63-4.65A7.45 7.45 0 0 1 5 11.5 7.5 7.5 0 0 1 12.5 4 7.5 7.5 0 0 1 20 11.5Z" /><path d="M9 11.5h.01M12.5 11.5h.01M16 11.5h.01" /></>,
  images: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9" r="1.25" /><path d="m4 17 4.5-4.5 3 3 2.25-2.25L20 19" /></>,
  library: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" /><path d="M4 5.5v16M8 7h8M8 11h8M8 15h5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  minus: <path d="M5 12h14" />,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  trash: <><path d="M4.5 7h15M9 7V4.5h6V7M7 7l.75 12.5h8.5L17 7M10 10.5v6M14 10.5v6" /></>,
  settings: <><path d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z" /><path d="m19.1 13.5 1.45 1.12-1.8 3.12-1.7-.68a7.9 7.9 0 0 1-1.7.98L15.1 20h-3.6l-.25-1.96a7.9 7.9 0 0 1-1.7-.98l-1.7.68-1.8-3.12L7.5 13.5a7.8 7.8 0 0 1 0-2.02L6.05 10.36l1.8-3.12 1.7.68a7.9 7.9 0 0 1 1.7-.98L11.5 5h3.6l.25 1.94a7.9 7.9 0 0 1 1.7.98l1.7-.68 1.8 3.12-1.45 1.12a7.8 7.8 0 0 1 0 2.02Z" /></>,
  chevronDown: <path d="m6.5 9 5.5 5.5L17.5 9" />,
  chevronUp: <path d="m6.5 15 5.5-5.5 5.5 5.5" />,
  chevronRight: <path d="m9 6.5 5.5 5.5L9 17.5" />,
  chevronLeft: <path d="m15 6.5-5.5 5.5 5.5 5.5" />,
  close: <><path d="m6.5 6.5 11 11M17.5 6.5l-11 11" /></>,
  search: <><circle cx="10.75" cy="10.75" r="6.25" /><path d="m16 16 4.25 4.25" /></>,
  refresh: <><path d="M19 8.5A7.5 7.5 0 1 0 19.25 15" /><path d="M19 4.5v4h-4" /></>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  list: <><path d="M8 6h12M8 12h12M8 18h12" /><circle cx="4.5" cy="6" r=".75" fill="currentColor" stroke="none" /><circle cx="4.5" cy="12" r=".75" fill="currentColor" stroke="none" /><circle cx="4.5" cy="18" r=".75" fill="currentColor" stroke="none" /></>,
  star: <path d="m12 3.75 2.55 5.16 5.7.83-4.12 4.02.97 5.68L12 16.76l-5.1 2.68.97-5.68-4.12-4.02 5.7-.83L12 3.75Z" />,
  check: <path d="m5.5 12.5 4.1 4.1L18.75 7.5" />,
  executionDone: <><circle cx="12" cy="12" r="8.25" /><path d="m8.25 12.25 2.35 2.35 5.25-5.2" /></>,
  executionActive: <><circle cx="12" cy="12" r="3.25" fill="currentColor" stroke="none" /><path d="M12 3.5v1.75M12 18.75v1.75M3.5 12h1.75M18.75 12h1.75" /></>,
  executionPending: <path d="m12 3.75 8.25 8.25L12 20.25 3.75 12 12 3.75Z" />,
  executionError: <><circle cx="12" cy="12" r="8.25" /><path d="m9.25 9.25 5.5 5.5M14.75 9.25l-5.5 5.5" /></>,
  paperclip: <path d="m8.75 12.75 5.95-5.95a3 3 0 0 1 4.25 4.25l-7.4 7.4a4.5 4.5 0 0 1-6.36-6.36l7.2-7.2" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  play: <path d="m8 5 10 7-10 7V5Z" />,
  circleAlert: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v5M12 16h.01" /></>,
  send: <><path d="m4 4 16 8-16 8 3.2-8L4 4Z" /><path d="M7.2 12H20" /></>,
  edit: <><path d="m4.5 16.75-.75 3.5 3.5-.75L18.5 8.25a2.47 2.47 0 0 0-3.5-3.5L4.5 16.75Z" /><path d="m13.5 6.25 4.25 4.25" /></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="1.5" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></>,
  folder: <path d="M3.5 7.5A2 2 0 0 1 5.5 5h4l2 2h9v10.5a2 2 0 0 1-2 2h-15Z" />,
  upload: <><path d="M12 16V4.5M7.5 9 12 4.5 16.5 9" /><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></>,
  download: <><path d="M12 4.5V16M7.5 11.5 12 16l4.5-4.5" /><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></>,
  panelLeft: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M9 4v16M6.25 8h.01M6.25 12h.01M6.25 16h.01" /></>,
  panelRight: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M15 4v16M17.75 8h.01M17.75 12h.01M17.75 16h.01" /></>,
  workflow: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="18" r="2" /><path d="M8 6h4a4 4 0 0 1 4 4v0M8 18h4a4 4 0 0 0 4-4v0" /></>,
  sliders: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="6" y="5" width="12" height="12" rx="1" />,
  restore: <><path d="M8 8h10v10H8z" /><path d="M6 16H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>,
  windowClose: <><path d="m7 7 10 10M17 7 7 17" /></>,
};

export default function Icon({ name, size = 16, strokeWidth = 1.8, className = '' }) {
  return (
    <svg
      className={`icon icon-${name} ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name] || PATHS.spark}
    </svg>
  );
}
