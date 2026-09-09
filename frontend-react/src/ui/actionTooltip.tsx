import type { ButtonHTMLAttributes } from 'react';

/** React replacement for the legacy action-tooltip attribute helper. */
export function actionTooltipProps(label: string): Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'aria-label'> {
  return { title: label, 'aria-label': label };
}
