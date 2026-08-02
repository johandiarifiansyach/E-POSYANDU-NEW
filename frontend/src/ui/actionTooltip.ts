let tooltipElement: HTMLDivElement | null = null;
let dismissListenersRegistered = false;

function registerDismissListeners() {
  if (dismissListenersRegistered) return;
  dismissListenersRegistered = true;
  document.addEventListener('click', hideActionTooltip, true);
  window.addEventListener('hashchange', hideActionTooltip);
  window.addEventListener('resize', hideActionTooltip);
}

function ensureTooltip() {
  if (tooltipElement?.isConnected) return tooltipElement;
  registerDismissListeners();
  tooltipElement = document.createElement('div');
  tooltipElement.className = 'table-action-tooltip';
  tooltipElement.setAttribute('role', 'tooltip');
  tooltipElement.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tooltipElement);
  return tooltipElement;
}

export function showActionTooltip(label: string, event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement) || !label) return;

  const tooltip = ensureTooltip();
  const targetBounds = target.getBoundingClientRect();
  tooltip.textContent = label;
  tooltip.dataset.placement = targetBounds.top >= 64 ? 'top' : 'bottom';
  tooltip.classList.add('is-visible');
  tooltip.setAttribute('aria-hidden', 'false');

  const tooltipBounds = tooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    window.innerWidth - tooltipBounds.width - 8,
    targetBounds.left + (targetBounds.width / 2) - (tooltipBounds.width / 2)
  ));
  const top = tooltip.dataset.placement === 'top'
    ? targetBounds.top - tooltipBounds.height - 10
    : targetBounds.bottom + 10;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

export function hideActionTooltip() {
  if (!tooltipElement) return;
  tooltipElement.classList.remove('is-visible');
  tooltipElement.setAttribute('aria-hidden', 'true');
}

export function actionTooltipProps(label: string) {
  return {
    'data-action-tooltip': label,
    onMouseEnter: (event: Event) => showActionTooltip(label, event),
    onMouseLeave: hideActionTooltip,
    onFocus: (event: Event) => showActionTooltip(label, event),
    onBlur: hideActionTooltip
  };
}
