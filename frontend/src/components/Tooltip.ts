// Tooltip behavior shared by sidebar and table actions.
// @ts-nocheck
import Native from '../runtime/dom';
import { actionTooltipProps, hideActionTooltip, showActionTooltip } from '../ui/actionTooltip';

export { actionTooltipProps, hideActionTooltip, showActionTooltip };

export const Tooltip = ({ label, children, className = '' }) => Native.createElement(
    'span',
    { className: `ui-tooltip ${className}`, ...actionTooltipProps(label) },
    children
);
