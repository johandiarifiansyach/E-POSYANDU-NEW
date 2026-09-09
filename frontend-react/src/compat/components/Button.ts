// Shared button variants used throughout the application.
import Native, { type DomChild } from '../runtime/dom';
import { Loader2 } from '../ui/icons';
import { actionTooltipProps } from '../ui/actionTooltip';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerFilled' | 'ghost' | 'actionBlue' | 'actionGreen' | 'actionRed' | 'actionOrange';

type ButtonProps = {
    children?: DomChild;
    onClick?: (event: Event) => void | Promise<void>;
    variant?: ButtonVariant;
    className?: string;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    title?: string;
};

export const Button = ({ children, onClick, variant = 'primary', className = '', disabled = false, type = 'button', title = '' }: ButtonProps) => {
    const baseStyle = 'apple-button px-4 py-2.5 rounded-xl font-semibold text-xs transition-all duration-200 flex items-center justify-center gap-2 focus:ring-4 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]';
    const variants: Record<ButtonVariant, string> = {
        primary: 'apple-button-primary bg-[#007aff] text-white hover:bg-[#006ee6] focus:ring-blue-100',
        secondary: 'apple-button-secondary bg-white/70 text-slate-700 border border-white/80 hover:bg-white hover:text-slate-900 focus:ring-slate-100',
        danger: 'apple-button-danger bg-rose-50/80 text-rose-600 hover:bg-rose-100 focus:ring-rose-50 border border-rose-100',
        dangerFilled: 'apple-button-danger-filled bg-[#ff3b30] text-white hover:bg-[#e8342b] focus:ring-rose-200',
        ghost: 'apple-button-ghost bg-transparent text-slate-600 hover:bg-white/60 hover:text-[#007aff] shadow-none',
        actionBlue: 'bg-blue-50/80 text-[#007aff] hover:bg-blue-100 border border-blue-100 px-3 py-2',
        actionGreen: 'bg-emerald-50/80 text-emerald-600 hover:bg-emerald-100 border border-emerald-100 px-3 py-2',
        actionRed: 'bg-rose-50/80 text-rose-600 hover:bg-rose-100 border border-rose-100 px-3 py-2',
        actionOrange: 'bg-orange-50/80 text-orange-600 hover:bg-orange-100 border border-orange-100 px-3 py-2'
    };
    const isTableAction = className.split(/\s+/).includes('table-action-button');
    const tooltipHandlers = isTableAction && title ? actionTooltipProps(title) : {};
    return Native.createElement(
        'button',
        { ...tooltipHandlers, type, onClick, disabled, title: isTableAction ? undefined : title, 'aria-label': title || undefined, className: `${baseStyle} ${variants[variant]} ${className}` },
        disabled && Native.createElement(Loader2, { className: 'w-3 h-3 animate-spin' }),
        children
    );
};
