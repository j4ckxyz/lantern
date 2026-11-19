// Line icons drawn inline, so there is no icon font or library to load.
import type { JSX, SVGAttributes } from 'preact'

type P = { size?: number } & SVGAttributes<SVGSVGElement>

const Svg = ({ size = 22, children, ...rest }: P & { children: JSX.Element | JSX.Element[] }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={1.8}
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...rest}>
    {children}
  </svg>
)

export const Send = (p: P) => <Svg {...p}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></Svg>
export const Stop = (p: P) => <Svg {...p}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></Svg>
export const Chevron = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
export const ChevronRight = (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>
export const Back = (p: P) => <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>
export const Close = (p: P) => <Svg {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>
export const More = (p: P) => <Svg {...p}><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></Svg>
export const Compose = (p: P) => <Svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Svg>
export const Compact = (p: P) => <Svg {...p}><path d="M4 7h16" /><path d="M7 12h10" /><path d="M10 17h4" /></Svg>
export const Chats = (p: P) => <Svg {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z" /></Svg>
export const Settings = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Svg>
export const Speaker = (p: P) => <Svg {...p}><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></Svg>
export const Play = (p: P) => <Svg {...p}><path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" stroke="none" /></Svg>
export const Pause = (p: P) => <Svg {...p}><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" /></Svg>
export const File = (p: P) => <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></Svg>
export const Globe = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" /></Svg>
export const QrIcon = (p: P) => <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h3v3" /></Svg>
export const Check = (p: P) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>
export const Cross = (p: P) => <Svg {...p}><path d="M17 7 7 17" /><path d="m7 7 10 10" /></Svg>
export const Spinner = (p: P) => <Svg {...p} class="spin"><path d="M12 3a9 9 0 1 0 9 9" /></Svg>
export const Search = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>
export const Shield = (p: P) => <Svg {...p}><path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6Z" /><path d="M12 9v4" /><path d="M12 16.5v.01" /></Svg>
export const Question = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" /><path d="M12 17v.01" /></Svg>
export const Info = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8v.01" /></Svg>
export const Alert = (p: P) => <Svg {...p}><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17v.01" /></Svg>
export const Down = (p: P) => <Svg {...p}><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></Svg>
export const Plug = (p: P) => <Svg {...p}><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0Z" /><path d="M12 17v5" /></Svg>
export const Key = (p: P) => <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 9.2-9.2" /><path d="m17 6 3 3" /><path d="m14 9 2 2" /></Svg>
export const Phone = (p: P) => <Svg {...p}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M11 18h2" /></Svg>
export const Keyboard = (p: P) => <Svg {...p}><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" /></Svg>
export const Image = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-9 9" /></Svg>
