const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
}

export function LogoIcon({ size = 18 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.2 5.4 9 2.6l4.8 2.8v5.2L9 13.4 4.2 10.6V5.4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="4.2" cy="5.4" r="1.3" fill="currentColor" />
      <circle cx="13.8" cy="5.4" r="1.3" fill="currentColor" />
      <circle cx="9" cy="13.4" r="1.3" fill="currentColor" />
      <circle cx="9" cy="8" r="1.1" fill="currentColor" />
      <path
        d="M5.3 6.2 9 8m4.7-1.8L9 8m0 0v4.1"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  )
}

export function SunIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" />
    </svg>
  )
}

export function MoonIcon() {
  return (
    <svg {...base}>
      <path d="M13.2 9.7A5.4 5.4 0 0 1 6.3 2.8 5.4 5.4 0 1 0 13.2 9.7Z" />
    </svg>
  )
}

export function MonitorIcon() {
  return (
    <svg {...base}>
      <rect x="1.8" y="2.5" width="12.4" height="8.2" rx="1" />
      <path d="M6 13.5h4M8 10.7v2.8" />
    </svg>
  )
}

export function ChevronRightIcon() {
  return (
    <svg {...base}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  )
}

export function ChevronDownIcon() {
  return (
    <svg {...base}>
      <path d="m3.5 6 4.5 4.5L12.5 6" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg {...base}>
      <path d="M1.8 4.2c0-.6.4-1 1-1h3l1.2 1.4h6.2c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1V4.2Z" />
    </svg>
  )
}

export function FileIcon() {
  return (
    <svg {...base}>
      <path d="M4 1.8h5l3 3v9.4H4V1.8Z" />
      <path d="M9 1.8v3h3" />
    </svg>
  )
}

export function CloseIcon() {
  return (
    <svg {...base}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  )
}

export function InfoIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.2v3.4M8 5.1v.1" />
    </svg>
  )
}

export function ArrowRightIcon() {
  return (
    <svg {...base} width={12} height={12}>
      <path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" />
    </svg>
  )
}

export function ArrowLeftIcon() {
  return (
    <svg {...base} width={12} height={12}>
      <path d="M13 8H3M6.5 4.5 3 8l3.5 3.5" />
    </svg>
  )
}

export function ArrowDownLeftIcon() {
  return (
    <svg {...base} width={11} height={11}>
      <path d="M12 4 4 12M4 6v6h6" />
    </svg>
  )
}

export function ArrowUpRightIcon() {
  return (
    <svg {...base} width={11} height={11}>
      <path d="M4 12 12 4M12 10V4H6" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg {...base}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </svg>
  )
}
