import type { SVGProps } from 'react';

/** Iconos de trazo propios (24×24, heredan el color del texto). */
type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 24, ...p }: P) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p,
});

export const IconScissors = (p: P) => (
  <svg {...base(p)}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M8.1 8.1 20 20M8.1 15.9 20 4M14.5 12l1 1" /></svg>
);
export const IconRazor = (p: P) => (
  <svg {...base(p)}><path d="M3 15.5 14.5 4a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L9 17.5" /><path d="M9 17.5 6.5 20a2.1 2.1 0 0 1-3-3l2-2" /><path d="M11 7.5 15.5 12" /></svg>
);
export const IconBeard = (p: P) => (
  <svg {...base(p)}><path d="M5 6v4a7 7 0 0 0 14 0V6" /><path d="M8.5 11.5c1-.8 2.2-1 3.5-1s2.5.2 3.5 1" /><path d="M10 15h4" /></svg>
);
export const IconComb = (p: P) => (
  <svg {...base(p)}><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v5M8 12v5M11 12v5M14 12v5M17 12v5M20 12v3" /></svg>
);
export const IconCamera = (p: P) => (
  <svg {...base(p)}><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.4-2h6.6l1.4 2h1.8A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" /><circle cx="12" cy="13" r="3.6" /></svg>
);
export const IconCalendar = (p: P) => (
  <svg {...base(p)}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2" /></svg>
);
export const IconRepeat = (p: P) => (
  <svg {...base(p)}><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></svg>
);
export const IconCard = (p: P) => (
  <svg {...base(p)}><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M2.5 10h19M6 15h4" /></svg>
);
export const IconBell = (p: P) => (
  <svg {...base(p)}><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
);
export const IconClock = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const IconPin = (p: P) => (
  <svg {...base(p)}><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" /><circle cx="12" cy="9.5" r="2.5" /></svg>
);
export const IconPhone = (p: P) => (
  <svg {...base(p)}><path d="M5 3h3.5l1.5 4.5-2 1.5a12 12 0 0 0 7 7l1.5-2 4.5 1.5V19a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2Z" /></svg>
);
export const IconSun = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
export const IconMoon = (p: P) => (
  <svg {...base(p)}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>
);
export const IconMenu = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);

/** Logotipo: tijeras dentro de un sello circular. */
export const Logo = ({ size = 34 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden className="logo-mark">
    <circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="20" cy="20" r="15" fill="none" stroke="var(--accent)" strokeWidth="1" strokeDasharray="2 2.2" />
    <g stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round">
      <circle cx="14" cy="14.5" r="2.6" /><circle cx="14" cy="25.5" r="2.6" />
      <path d="M16 16.3 27 26.5M16 23.7 27 13.5" />
    </g>
  </svg>
);
export const IconTicket = (p: P) => (
  <svg {...base(p)}><path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>
);
export const IconChevronLeft = (p: P) => (
  <svg {...base(p)}><path d="m15 18-6-6 6-6" /></svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...base(p)}><path d="m9 18 6-6-6-6" /></svg>
);
