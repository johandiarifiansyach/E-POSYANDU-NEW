import Native from '../runtime/dom';

type IconProps = Record<string, unknown> & { className?: string; size?: number | string };
type IconNode = [string, Record<string, string>];

function createIcon(nodes: IconNode[]) {
  return function NativeIcon(props: IconProps = {}) {
    const { className, size = 24, ...rest } = props;
    const hasAccessibleName = Boolean(rest['aria-label'] || rest['aria-labelledby']);
    return Native.createElement(
      'svg',
      {
        ...rest,
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        focusable: false,
        ...(hasAccessibleName ? {} : { 'aria-hidden': 'true' }),
        className: `apple-symbol${className ? ` ${className}` : ''}`
      },
      nodes.map(([tag, attributes]) => Native.createElement(tag, attributes))
    );
  };
}

// Original Apple-system-inspired glyphs. These avoid bundling Apple's proprietary SF Symbols.
export const Activity = createIcon([["path", { "d": "M2.5 12h4l2.35-7.3 4.3 14.6 2.35-7.3h6", "key": "pulse" }]]);
export const AlertCircle = createIcon([["circle", { "cx": "12", "cy": "12", "r": "9.25", "key": "ring" }], ["path", { "d": "M12 7.2v5.9", "key": "mark" }], ["circle", { "cx": "12", "cy": "16.65", "r": ".7", "fill": "currentColor", "stroke": "none", "key": "dot" }]]);
export const AlertTriangle = createIcon([["path", { "d": "M10.35 4.25 2.7 18a2 2 0 0 0 1.75 3h15.1a2 2 0 0 0 1.75-3L13.65 4.25a1.9 1.9 0 0 0-3.3 0Z", "key": "triangle" }], ["path", { "d": "M12 9v4.4", "key": "mark" }], ["circle", { "cx": "12", "cy": "17", "r": ".65", "fill": "currentColor", "stroke": "none", "key": "dot" }]]);
export const ArrowLeft = createIcon([["path", { "d": "m10.5 5-7 7 7 7", "key": "head" }], ["path", { "d": "M4 12h16.5", "key": "shaft" }]]);
export const Baby = createIcon([["path", { "d": "M8.2 5.15A8.15 8.15 0 1 0 19.4 9.1", "key": "face" }], ["path", { "d": "M8.15 5.2c.55-2.15 3.85-2.9 5.15-1.05 1.1 1.55-.15 3.65-1.9 3.4-1.05-.15-1.55-1.15-1.15-2.05", "key": "curl" }], ["circle", { "cx": "8.9", "cy": "12", "r": ".75", "fill": "currentColor", "stroke": "none", "key": "eye1" }], ["circle", { "cx": "15.1", "cy": "12", "r": ".75", "fill": "currentColor", "stroke": "none", "key": "eye2" }], ["path", { "d": "M9.3 16c1.55 1.2 3.85 1.2 5.4 0", "key": "smile" }]]);
export const Calendar = createIcon([["rect", { "x": "3", "y": "4.5", "width": "18", "height": "16.5", "rx": "3.5", "key": "body" }], ["path", { "d": "M7.5 2.8v3.5M16.5 2.8v3.5M3 9.2h18", "key": "bindings" }]]);
export const CalendarDays = createIcon([["rect", { "x": "3", "y": "4.5", "width": "18", "height": "16.5", "rx": "3.5", "key": "body" }], ["path", { "d": "M7.5 2.8v3.5M16.5 2.8v3.5M3 9.2h18M7.4 13h.01M12 13h.01M16.6 13h.01M7.4 17h.01M12 17h.01M16.6 17h.01", "key": "details" }]]);
export const CheckCircle2 = createIcon([["circle", { "cx": "12", "cy": "12", "r": "9.25", "key": "ring" }], ["path", { "d": "m7.8 12.2 2.75 2.75 5.8-6", "key": "check" }]]);
export const CheckSquare = createIcon([["rect", { "x": "3", "y": "3", "width": "18", "height": "18", "rx": "4.25", "key": "box" }], ["path", { "d": "m7.5 12.15 2.8 2.8 6.25-6.4", "key": "check" }]]);
export const ChevronDown = createIcon([["path", { "d": "m6.5 9.5 5.5 5.25 5.5-5.25", "key": "chevron" }]]);
export const ChevronLeft = createIcon([["path", { "d": "m14.75 5.5-6.25 6.5 6.25 6.5", "key": "chevron" }]]);
export const ChevronRight = createIcon([["path", { "d": "m9.25 5.5 6.25 6.5-6.25 6.5", "key": "chevron" }]]);
export const CircleOff = createIcon([["circle", { "cx": "12", "cy": "12", "r": "9.25", "key": "ring" }], ["path", { "d": "M5.45 5.45 18.55 18.55", "key": "slash" }]]);
export const ClipboardCheck = createIcon([["rect", { "x": "4.5", "y": "4", "width": "15", "height": "17.5", "rx": "3.25", "key": "board" }], ["rect", { "x": "8.25", "y": "2.5", "width": "7.5", "height": "4", "rx": "2", "key": "clip" }], ["path", { "d": "m8.1 14.1 2.45 2.4 5.35-5.4", "key": "check" }]]);
export const Clock = createIcon([["circle", { "cx": "12", "cy": "12", "r": "9.25", "key": "ring" }], ["path", { "d": "M12 6.7v5.65l3.75 2.2", "key": "hands" }]]);
export const Eye = createIcon([["path", { "d": "M2.5 12s3.45-5.75 9.5-5.75S21.5 12 21.5 12s-3.45 5.75-9.5 5.75S2.5 12 2.5 12Z", "key": "eye" }], ["circle", { "cx": "12", "cy": "12", "r": "2.75", "key": "pupil" }]]);
export const EyeOff = createIcon([["path", { "d": "M4.2 8.55C3.05 9.65 2.5 12 2.5 12s3.45 5.75 9.5 5.75c1.35 0 2.6-.28 3.7-.72M8.1 6.7A10.6 10.6 0 0 1 12 6.25c6.05 0 9.5 5.75 9.5 5.75a12 12 0 0 1-2.05 2.8", "key": "eye" }], ["path", { "d": "M9.8 9.75a3.05 3.05 0 0 0 4.45 4.4M3.2 3.2l17.6 17.6", "key": "slash" }]]);
export const FileDown = createIcon([["path", { "d": "M6.25 2.75h7.5l4 4v14.5H6.25a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2Z", "key": "file" }], ["path", { "d": "M13.75 2.75v4h4M11 11v6M8.5 14.5 11 17l2.5-2.5", "key": "action" }]]);
export const FileText = createIcon([["path", { "d": "M6.25 2.75h7.5l4 4v14.5H6.25a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2Z", "key": "file" }], ["path", { "d": "M13.75 2.75v4h4M8 11h6M8 15h6M8 18h4", "key": "details" }]]);
export const FileUp = createIcon([["path", { "d": "M6.25 2.75h7.5l4 4v14.5H6.25a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2Z", "key": "file" }], ["path", { "d": "M13.75 2.75v4h4M11 17v-6M8.5 13.5 11 11l2.5 2.5", "key": "action" }]]);
export const Filter = createIcon([["path", { "d": "M3.5 6h17M5.75 12h12.5M8.25 18h7.5", "key": "lines" }]]);
export const Gift = createIcon([["rect", { "x": "3", "y": "9", "width": "18", "height": "12", "rx": "2.5", "key": "box" }], ["path", { "d": "M2.75 9h18.5V6.75h-18.5V9ZM12 6.75V21", "key": "ribbon" }], ["path", { "d": "M11.8 6.6C9.75 6.55 6.5 5.9 6.5 3.95c0-1.25 1.05-1.8 2-1.35 1.65.8 2.65 2.35 3.3 4ZM12.2 6.6c2.05-.05 5.3-.7 5.3-2.65 0-1.25-1.05-1.8-2-1.35-1.65.8-2.65 2.35-3.3 4Z", "key": "bow" }]]);
export const History = createIcon([["path", { "d": "M4.25 8V3.75H8.5", "key": "head" }], ["path", { "d": "M4.75 7.15A8.75 8.75 0 1 1 3.25 14", "key": "ring" }], ["path", { "d": "M12 7.25v5.1l3.35 1.95", "key": "hands" }]]);
export const LayoutDashboard = createIcon([["rect", { "x": "3", "y": "3", "width": "7.5", "height": "7.5", "rx": "2", "key": "a" }], ["rect", { "x": "13.5", "y": "3", "width": "7.5", "height": "7.5", "rx": "2", "key": "b" }], ["rect", { "x": "3", "y": "13.5", "width": "7.5", "height": "7.5", "rx": "2", "key": "c" }], ["rect", { "x": "13.5", "y": "13.5", "width": "7.5", "height": "7.5", "rx": "2", "key": "d" }]]);
export const Loader2 = createIcon([["path", { "d": "M20.5 12a8.5 8.5 0 1 1-5.3-7.85", "key": "arc" }]]);
export const LogOut = createIcon([["path", { "d": "M10 4.25H6.25a2 2 0 0 0-2 2v11.5a2 2 0 0 0 2 2H10", "key": "door" }], ["path", { "d": "M13.5 7.5 18 12l-4.5 4.5M8.5 12H18", "key": "arrow" }]]);
export const MapPin = createIcon([["path", { "d": "M12 21s7-6.15 7-12a7 7 0 1 0-14 0c0 5.85 7 12 7 12Z", "key": "pin" }], ["circle", { "cx": "12", "cy": "9", "r": "2.5", "key": "center" }]]);
export const Menu = createIcon([["path", { "d": "M4 6.25h16M4 12h16M4 17.75h16", "key": "lines" }]]);
export const Minus = createIcon([["path", { "d": "M5 12h14", "key": "minus" }]]);
export const Moon = createIcon([["path", { "d": "M20.25 14.15A8.55 8.55 0 0 1 9.85 3.75 8.7 8.7 0 1 0 20.25 14.15Z", "key": "moon" }]]);
export const Pencil = createIcon([["path", { "d": "m4 16.5-1 4.5 4.5-1L19.7 7.8a2.65 2.65 0 0 0-3.75-3.75L4 16.5Z", "key": "body" }], ["path", { "d": "m14.3 5.7 4 4", "key": "seam" }]]);
export const Plus = createIcon([["path", { "d": "M5 12h14M12 5v14", "key": "plus" }]]);
export const RotateCcw = createIcon([["path", { "d": "M4.25 8V3.75H8.5", "key": "head" }], ["path", { "d": "M4.75 7.15A8.75 8.75 0 1 1 3.25 14", "key": "arc" }]]);
export const Ruler = createIcon([["rect", { "x": "2.5", "y": "7", "width": "19", "height": "10", "rx": "3", "key": "body" }], ["path", { "d": "M7 7v4M11 7v2.5M15 7v4M19 7v2.5", "key": "ticks" }]]);
export const Scale = createIcon([["rect", { "x": "3", "y": "3.5", "width": "18", "height": "17.5", "rx": "4", "key": "body" }], ["path", { "d": "M7.25 10.25a4.75 4.75 0 0 1 9.5 0M12 10.25l2.55-2.15M7.5 17h9", "key": "dial" }]]);
export const Search = createIcon([["circle", { "cx": "10.75", "cy": "10.75", "r": "7.25", "key": "lens" }], ["path", { "d": "m16.1 16.1 4.4 4.4", "key": "handle" }]]);
export const Sun = createIcon([["circle", { "cx": "12", "cy": "12", "r": "3.75", "key": "center" }], ["path", { "d": "M12 2.25v2.1M12 19.65v2.1M2.25 12h2.1M19.65 12h2.1M5.1 5.1l1.5 1.5M17.4 17.4l1.5 1.5M18.9 5.1l-1.5 1.5M6.6 17.4l-1.5 1.5", "key": "rays" }]]);
export const Trash2 = createIcon([["path", { "d": "M4.25 6.75h15.5M9 3.5h6l1.15 3.25M6.25 6.75l.85 13.75h9.8l.85-13.75M10 10.25v6.5M14 10.25v6.5", "key": "bin" }]]);
export const TrendingDown = createIcon([["path", { "d": "m3.25 6.5 6.1 6.15 4.2-4.2 7.2 7.15", "key": "line" }], ["path", { "d": "M16.25 15.6h4.5v-4.5", "key": "head" }]]);
export const TrendingUp = createIcon([["path", { "d": "m3.25 17.5 6.1-6.15 4.2 4.2 7.2-7.15", "key": "line" }], ["path", { "d": "M16.25 8.4h4.5v4.5", "key": "head" }]]);
export const UserPlus = createIcon([["circle", { "cx": "9", "cy": "8", "r": "3.5", "key": "head" }], ["path", { "d": "M2.75 20c.35-3.65 2.65-6 6.25-6s5.9 2.35 6.25 6", "key": "body" }], ["circle", { "cx": "18", "cy": "9", "r": "3.25", "key": "badge" }], ["path", { "d": "M18 7.35v3.3M16.35 9h3.3", "key": "plus" }]]);
export const UserRound = createIcon([["circle", { "cx": "12", "cy": "8", "r": "3.75", "key": "head" }], ["path", { "d": "M4.25 20.25c.35-4.1 3.25-6.5 7.75-6.5s7.4 2.4 7.75 6.5", "key": "body" }]]);
export const Users = createIcon([["circle", { "cx": "8.75", "cy": "8", "r": "3.25", "key": "head1" }], ["path", { "d": "M2.5 19.75c.35-3.6 2.7-5.75 6.25-5.75S14.65 16.15 15 19.75", "key": "body1" }], ["circle", { "cx": "16.75", "cy": "7.25", "r": "2.5", "key": "head2" }], ["path", { "d": "M15.25 13.4c.5-.18 1-.27 1.55-.27 2.85 0 4.45 1.75 4.7 4.7", "key": "body2" }]]);
export const Utensils = createIcon([["path", { "d": "M5 2.75v6.5M8 2.75v6.5M2 2.75v4.5A3 3 0 0 0 5 10.2V21M18 13.25c2.2 0 4-2.35 4-5.25s-1.8-5.25-4-5.25S14 5.1 14 8s1.8 5.25 4 5.25ZM18 13.25V21", "key": "utensils" }]]);
export const X = createIcon([["path", { "d": "m6.25 6.25 11.5 11.5M17.75 6.25l-11.5 11.5", "key": "x" }]]);
export const XCircle = createIcon([["circle", { "cx": "12", "cy": "12", "r": "9.25", "key": "ring" }], ["path", { "d": "m8.75 8.75 6.5 6.5M15.25 8.75l-6.5 6.5", "key": "x" }]]);
