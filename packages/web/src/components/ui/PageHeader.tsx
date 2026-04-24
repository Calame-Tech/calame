import React from 'react';
import { cn } from './cn.js';

export interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

export interface PageHeaderProps {
  title: string;
  description?: string;
  breadcrumb?: BreadcrumbItem[];
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Page-level header with optional breadcrumb, title, description and action slot.
 * Uses font-display for the title, mono-plex for the breadcrumb, hairline-b separator.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  className,
}: PageHeaderProps): React.ReactElement {
  return (
    <header className={cn('flex flex-col gap-1.5 pb-4 mb-2 hairline-b', className)}>
      {/* Breadcrumb */}
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-1.5 flex-wrap">
            {breadcrumb.map((item, index) => {
              const isLast = index === breadcrumb.length - 1;
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
                        'font-mono-plex text-[10px] uppercase tracking-widest text-gray-500 hover:text-gray-300 transition-colors',
                        'focus:outline-none focus:ring-2 focus:ring-os-400 rounded',
                      )}
                    >
                      {item.label}
                    </button>
                  ) : (
                    <span
                      className={cn(
                        'font-mono-plex text-[10px] uppercase tracking-widest',
                        isLast ? 'text-gray-400' : 'text-gray-500',
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
      )}

      {/* Title row */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <h1 className="heading-md truncate">{title}</h1>
          {description && <p className="text-sm text-gray-500 mt-0.5">{description}</p>}
        </div>

        {actions && <div className="flex-shrink-0 flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export default PageHeader;
