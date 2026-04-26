import React from 'react';
import { cn } from './cn.js';

export interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

/**
 * Editorial breadcrumb — small mono-plex caps, separator slashes, bright os-* tint
 * for actionable crumbs. Used both standalone and inside PageHeader.
 */
export function Breadcrumb({ items, className }: BreadcrumbProps): React.ReactElement | null {
  if (!items || items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex items-center gap-1.5 flex-wrap">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={index} className="flex items-center gap-1.5">
              {index > 0 && (
                <span
                  className="font-mono-plex text-[10px] text-gray-600 select-none"
                  aria-hidden="true"
                >
                  /
                </span>
              )}
              {item.onClick && !isLast ? (
                <button
                  type="button"
                  onClick={item.onClick}
                  className={cn(
                    'font-mono-plex text-[10px] uppercase tracking-widest',
                    'text-os-400 hover:text-os-300 transition-colors',
                    'focus:outline-none focus:ring-2 focus:ring-os-400 rounded',
                  )}
                >
                  {item.label}
                </button>
              ) : (
                <span
                  className={cn(
                    'font-mono-plex text-[10px] uppercase tracking-widest',
                    isLast ? 'text-gray-300' : 'text-os-400',
                  )}
                  aria-current={isLast ? 'page' : undefined}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumb;
