import React from 'react';
import { cn } from './cn.js';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/**
 * Centered empty-state placeholder for lists and panels with no data yet.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 py-12 px-6 text-center',
        className,
      )}
    >
      {icon && (
        <div
          className="flex items-center justify-center w-10 h-10 rounded-full bg-white/5 text-gray-400"
          aria-hidden="true"
        >
          {icon}
        </div>
      )}

      <div className="flex flex-col gap-1.5 max-w-sm">
        <h3 className="heading-md">{title}</h3>
        {description && <p className="text-sm text-gray-500 leading-relaxed">{description}</p>}
      </div>

      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export default EmptyState;
