// Shared modal shell. Feature dialogs can add their own form and data logic.
// @ts-nocheck
import Native from '../runtime/dom';

export const Modal = ({ children, onClose, title = '', className = '', backdropClassName = '', panelClassName = '', bodyClassName = 'p-4', footer = null }) => Native.createElement(
    'div',
    { className: `fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-md overflow-y-auto ${backdropClassName}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    Native.createElement('div', { className: `app-card w-full max-w-3xl max-h-[90vh] overflow-y-auto ${panelClassName} ${className}` },
        Native.createElement('div', { className: 'flex items-center justify-between border-b border-slate-200/70 p-4' },
            Native.createElement('h2', { className: 'text-lg font-bold' }, title),
            Native.createElement('button', { type: 'button', onClick: onClose, 'aria-label': 'Tutup' }, '×')),
        Native.createElement('div', { className: bodyClassName }, children),
        footer && Native.createElement('div', { className: 'border-t border-slate-200/70 p-4' }, footer))
);
