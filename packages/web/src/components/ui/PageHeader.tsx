import React from 'react';
import { cn } from './cn.js';
import { Breadcrumb, type BreadcrumbItem } from './Breadcrumb.js';

export type { BreadcrumbItem };

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
      {breadcrumb && breadcrumb.length > 0 && <Breadcrumb items={breadcrumb} />}

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
