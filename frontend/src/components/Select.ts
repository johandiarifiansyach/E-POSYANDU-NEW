// Shared select control used by filters and forms.
// @ts-nocheck
import Native from '../runtime/dom';
import { ChevronDown } from '../ui/icons';

export const Select = ({ value, onChange, options, disabled, required = false, className = '' }) => Native.createElement(
    'div',
    { className: 'relative w-full' },
    Native.createElement(
        'select',
        {
            value,
            onChange,
            disabled,
            required,
            className: `apple-select w-full appearance-none bg-white/70 border border-slate-200/70 text-slate-900 text-sm rounded-xl focus:ring-blue-500 focus:border-blue-500 block p-2.5 pr-8 disabled:bg-slate-100 disabled:text-slate-400 transition-shadow ${className}`
        },
        options.map((opt) => Native.createElement('option', { key: opt.value, value: opt.value }, opt.label))
    ),
    Native.createElement(ChevronDown, { className: 'absolute right-3 top-3 w-4 h-4 text-slate-400 pointer-events-none' })
);
