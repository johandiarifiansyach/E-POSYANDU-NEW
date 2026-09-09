import type { ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, className = '', ...props }: IconProps & { children: ReactNode }) {
  return <svg {...props} className={`h-5 w-5 ${className}`.trim()} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={props['aria-label'] ? undefined : true}>{children}</svg>;
}

/** Provider marks used by the administrator service-health cards.  They are
 * kept inline so the React bundle has no third-party icon/CDN dependency. */
function BrandIcon({ children, className = '', ...props }: IconProps & { children: ReactNode }) {
  return <svg {...props} className={`service-brand-icon${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" fill="none" focusable="false" aria-hidden={props['aria-label'] ? undefined : true}>{children}</svg>;
}

export const CloudflareLogo = (props: IconProps) => <BrandIcon {...props}><path fill="#f48120" d="M20.75 15.15a4.6 4.6 0 0 0-4.45-3.45c-.46 0-.9.07-1.31.2A5.65 5.65 0 0 0 4.1 13.15H18.9a2.4 2.4 0 0 1 1.85 2Z" /><path fill="#faad3f" d="M19.15 14.4H7.25a2.9 2.9 0 0 0 0 5.8h11.9a2.15 2.15 0 0 0 0-4.3Z" /></BrandIcon>;
export const RedisLogo = (props: IconProps) => <BrandIcon {...props}><polygon fill="#dc382d" points="12 2.7 21 7.1 12 11.55 3 7.1" /><polygon fill="#a41e11" points="3 7.1 12 11.55 12 21.3 3 16.85" /><polygon fill="#c42a20" points="21 7.1 12 11.55 12 21.3 21 16.85" /><path fill="#fff" d="M7.1 6.75h3.25c1.15 0 1.8.5 1.8 1.35 0 .58-.3 1.02-.84 1.25.7.2 1.08.66 1.08 1.3 0 .98-.76 1.55-2.06 1.55H7.1Zm1.45 1.05v.95h1.48c.45 0 .67-.16.67-.48 0-.31-.22-.47-.67-.47Zm0 1.95v1.1h1.62c.48 0 .72-.18.72-.55 0-.36-.24-.55-.72-.55Z" /></BrandIcon>;
export const SupabaseLogo = (props: IconProps) => <BrandIcon {...props}><path fill="#3ecf8e" d="M13.35 2.7 4.8 12.7a1.15 1.15 0 0 0 .88 1.9h5.45l-1.1 6.7a.72.72 0 0 0 1.28.56l8.7-10.35a1.15 1.15 0 0 0-.88-1.9h-5.2l.7-6.2a.72.72 0 0 0-1.28-.71Z" /><path fill="#249b68" d="m11.15 14.6-1.1 6.7a.72.72 0 0 0 1.28.56l8.7-10.35a1.15 1.15 0 0 0-.88-1.9h-5.2l-.22 1.92h2.6l-5.18 3.07Z" /></BrandIcon>;
export const NeonLogo = (props: IconProps) => <BrandIcon {...props}><path fill="#00e599" d="M4.3 4.1h3.1l8.3 10.1V4.1h3.9v15.8h-3.1L8.2 9.75v10.15H4.3Z" /><path fill="#8a5cf6" d="M15.7 4.1h3.9v15.8h-3.9Z" /></BrandIcon>;
export const PostgreSQLLogo = (props: IconProps) => <BrandIcon {...props}><path fill="#336791" d="M6.15 18.55c-1.58-2.08-1.8-6.5-.4-9.84C7.08 5.55 9.75 3.1 13 3.1c3.48 0 5.6 2.18 5.6 5.45 0 2.65-1.16 4.63-3.45 5.88v3.95c0 .84-.68 1.52-1.52 1.52h-4.7v-1.55h2.48v-3.2c-2.17.2-3.94-.58-5.26-2.32Z" /><circle fill="#fff" cx="14.35" cy="8.45" r="1.15" /><circle fill="#336791" cx="14.55" cy="8.35" r=".42" /><path fill="#fff" d="M15.8 11.3c1.1-.3 2.05-.82 2.83-1.55-.1 1.35-.74 2.48-1.9 3.37Z" /></BrandIcon>;

export const X = (props: IconProps) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18" /></Icon>;
export const XCircle = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9.25" /><path d="m8.75 8.75 6.5 6.5M15.25 8.75l-6.5 6.5" /></Icon>;
export const AlertTriangle = (props: IconProps) => <Icon {...props}><path d="m10.3 4.5-7.6 13.8a2 2 0 0 0 1.8 3h15a2 2 0 0 0 1.8-3L13.7 4.5a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4.2M12 17.2h.01" /></Icon>;
export const AlertCircle = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></Icon>;
export const CheckCircle2 = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9.25" /><path d="m7.8 12.2 2.75 2.75 5.8-6" /></Icon>;
export const TrendingUp = (props: IconProps) => <Icon {...props}><path d="m3 17 6-6 4 4 7-7" /><path d="M15 8h5v5" /></Icon>;
export const TrendingDown = (props: IconProps) => <Icon {...props}><path d="m3 7 6 6 4-4 7 7" /><path d="M15 16h5v-5" /></Icon>;
export const Loader2 = (props: IconProps) => <Icon {...props} className={`animate-spin ${props.className || ''}`}><path d="M12 3a9 9 0 1 0 9 9" /></Icon>;
export const FileDown = (props: IconProps) => <Icon {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M12 11v6M9 14l3 3 3-3" /></Icon>;
export const Calendar = (props: IconProps) => <Icon {...props}><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M8 2.5v4M16 2.5v4M3 9h18" /></Icon>;
export const Gift = (props: IconProps) => <Icon {...props}><path d="M3 10h18v11H3zM2 7h20v3H2zM12 7v14M12 7H8.5A2.5 2.5 0 1 1 11 4.5V7ZM12 7h3.5A2.5 2.5 0 1 0 13 4.5V7Z" /></Icon>;
export const ClipboardCheck = (props: IconProps) => <Icon {...props}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5V3h6v1.5M8.5 13l2.2 2.2 4.8-5" /></Icon>;
export const CheckSquare = (props: IconProps) => <Icon {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8 12 2.5 2.5L16 9" /></Icon>;
export const Utensils = (props: IconProps) => <Icon {...props}><path d="M7 3v7M4.5 3v4a2.5 2.5 0 0 0 5 0V3M7 10v11M16 3v18M16 3c2 2 3 4.5 3 7h-3" /></Icon>;
export const MapPin = (props: IconProps) => <Icon {...props}><path d="M12 21s7-6.15 7-12a7 7 0 1 0-14 0c0 5.85 7 12 7 12Z" /><circle cx="12" cy="9" r="2.5" /></Icon>;
export const Baby = (props: IconProps) => <Icon {...props}><path d="M8.2 5.15A8.15 8.15 0 1 0 19.4 9.1" /><path d="M8.15 5.2c.55-2.15 3.85-2.9 5.15-1.05 1.1 1.55-.15 3.65-1.9 3.4-1.05-.15-1.55-1.15-1.15-2.05" /><circle cx="8.9" cy="12" r=".75" fill="currentColor" stroke="none" /><circle cx="15.1" cy="12" r=".75" fill="currentColor" stroke="none" /><path d="M9.3 16c1.55 1.2 3.85 1.2 5.4 0" /></Icon>;
export const CircleOff = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="m5.5 5.5 13 13" /></Icon>;
export const Minus = (props: IconProps) => <Icon {...props}><path d="M5 12h14" /></Icon>;
export const Scale = (props: IconProps) => <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 11a5 5 0 0 1 10 0M12 11l2.5-2M7 17h10" /></Icon>;
export const Activity = TrendingUp;
export const ArrowLeft = (props: IconProps) => <Icon {...props}><path d="M19 12H5M11 6l-6 6 6 6" /></Icon>;
export const CalendarDays = Calendar;
export const ChevronDown = (props: IconProps) => <Icon {...props}><path d="m6 9 6 6 6-6" /></Icon>;
export const ChevronLeft = (props: IconProps) => <Icon {...props}><path d="m14.75 5.5-6.25 6.5 6.25 6.5" /></Icon>;
export const ChevronRight = (props: IconProps) => <Icon {...props}><path d="m10 6 6 6-6 6" /></Icon>;
export const Clock = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
export const Eye = (props: IconProps) => <Icon {...props}><path d="M2.5 12s3.5-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.5 5.5-9.5 5.5-9.5-5.5-9.5-5.5Z" /><circle cx="12" cy="12" r="2.5" /></Icon>;
export const EyeOff = (props: IconProps) => <Icon {...props}><path d="m4 4 16 16M10.6 6.7A10.4 10.4 0 0 1 12 6.5c6 0 9.5 5.5 9.5 5.5a16 16 0 0 1-3 3.4M6.1 6.8C3.7 8.5 2.5 12 2.5 12s3.5 5.5 9.5 5.5c1.5 0 2.8-.3 4-.8" /></Icon>;
export const FileText = FileDown;
export const FileUp = FileDown;
export const Filter = (props: IconProps) => <Icon {...props}><path d="M4 6h16M7 12h10M10 18h4" /></Icon>;
export const History = Clock;
export const LayoutDashboard = (props: IconProps) => <Icon {...props}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>;
export const LogOut = (props: IconProps) => <Icon {...props}><path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M14 8l4 4-4 4M9 12h9" /></Icon>;
export const Menu = (props: IconProps) => <Icon {...props}><path d="M4 6h16M4 12h16M4 18h16" /></Icon>;
export const Moon = (props: IconProps) => <Icon {...props}><path d="M20 15a8 8 0 0 1-11-11 8 8 0 1 0 11 11Z" /></Icon>;
export const Pencil = (props: IconProps) => <Icon {...props}><path d="m4 16 10-10 4 4L8 20l-5 1 1-5ZM13 7l4 4" /></Icon>;
export const Plus = (props: IconProps) => <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
export const RotateCcw = (props: IconProps) => <Icon {...props}><path d="M4 8V4h4M4.5 7.5A8.5 8.5 0 1 1 4 14" /></Icon>;
export const Ruler = (props: IconProps) => <Icon {...props}><rect x="3" y="7" width="18" height="10" rx="2" /><path d="M7 7v4M11 7v2M15 7v4M19 7v2" /></Icon>;
export const Search = (props: IconProps) => <Icon {...props}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></Icon>;
export const Sun = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></Icon>;
export const Trash2 = (props: IconProps) => <Icon {...props}><path d="M4 7h16M10 3h4l1 4H9l1-4ZM6 7l1 14h10l1-14M10 11v6M14 11v6" /></Icon>;
export const UserPlus = (props: IconProps) => <Icon {...props}><circle cx="9" cy="8" r="3.5" /><path d="M2.75 20c.35-3.65 2.65-6 6.25-6s5.9 2.35 6.25 6" /><circle cx="18" cy="9" r="3.25" /><path d="M18 7.35v3.3M16.35 9h3.3" /></Icon>;
export const UserRound = (props: IconProps) => <Icon {...props}><circle cx="12" cy="8" r="3.75" /><path d="M4.25 20.25c.35-4.1 3.25-6.5 7.75-6.5s7.4 2.4 7.75 6.5" /></Icon>;
export const Users = (props: IconProps) => <Icon {...props}><circle cx="9" cy="8" r="3" /><path d="M3 20c.4-3.5 2.5-5.5 6-5.5s5.6 2 6 5.5M17 6.5a2.5 2.5 0 1 1 0 5M16 14.5c2.5-.1 4.3 1.7 4.6 4" /></Icon>;
