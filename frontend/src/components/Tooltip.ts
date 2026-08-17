// Tooltip behavior shared by sidebar and table actions.
import Native, { type DomChild } from '../runtime/dom';
import { actionTooltipProps, hideActionTooltip, showActionTooltip } from '../ui/actionTooltip';

export { actionTooltipProps, hideActionTooltip, showActionTooltip };

type TooltipProps = { label: string; children?: DomChild; className?: string };

export const Tooltip = ({ label, children, className = '' }: TooltipProps) => Native.createElement(
    'span',
    { className: `ui-tooltip ${className}`, ...actionTooltipProps(label) },
    children
);
