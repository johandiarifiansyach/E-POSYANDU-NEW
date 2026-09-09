import type { HTMLAttributes } from 'react';

export type SkeletonBlockProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  className?: string;
};

/**
 * Shared loading primitive. The shared application stylesheet owns the animation and
 * dimensions; React only supplies the semantic element and class contract.
 */
export default function SkeletonBlock({ className = '', ...props }: SkeletonBlockProps) {
  return <span {...props} className={`app-skeleton-block${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
