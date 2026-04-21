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
        'flex flex-col items-center justify-center gap-4 py-16 px-6 text-center',
        className,
      )}
    >
      {icon && (
        <div
          className="flex items-center justify-center w-14 h-14 rounded-full bg-gray-800/80 text-gray-400"
          aria-hidden="true"
        >
          {icon}
        </div>
      )}

      <div className="flex flex-col gap-2 max-w-sm">
        <h3 className="text-lg font-semibold text-gray-100">{title}</h3>
        {description && <p className="text-sm text-gray-400 leading-relaxed">{description}</p>}
      </div>

      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export default EmptyState;
