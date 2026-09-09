import type { ReactNode } from 'react';
import { Card } from '../base/Card';

export type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

/** Empty result state shared by all server-paged React tables. */
export default function EmptyState({ title, description, action }: EmptyStateProps) {
  return <Card className="p-8 text-center text-slate-500">
    <p className="font-semibold text-slate-700">{title}</p>
    {description ? <p className="mt-1 text-sm">{description}</p> : null}
    {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
  </Card>;
}
