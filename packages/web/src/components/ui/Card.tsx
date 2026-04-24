import React from 'react';
import { cn } from './cn.js';

export interface CardProps {
  children: React.ReactNode;
  className?: string;
  /** Add default p-6 padding. Default: true */
  padded?: boolean;
  /** Add hover border/bg transitions. Default: false */
  hoverable?: boolean;
  as?: 'div' | 'section' | 'article';
}

/**
 * Base card container with glassmorphism-style dark theme.
 */
export function Card({
  children,
  className,
  padded = true,
  hoverable = false,
  as: Tag = 'div',
}: CardProps): React.ReactElement {
  return (
    <Tag
      className={cn(
        'card-primary',
        padded && 'p-4',
        hoverable && 'card-interactive cursor-pointer',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

export interface CardHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function CardHeader({ children, className }: CardHeaderProps): React.ReactElement {
  return <div className={cn('flex flex-col gap-1.5', className)}>{children}</div>;
}

export interface CardTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function CardTitle({ children, className }: CardTitleProps): React.ReactElement {
  return (
    <h3 className={cn('text-base font-semibold leading-none text-gray-100', className)}>
      {children}
    </h3>
  );
}

export interface CardDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

export function CardDescription({ children, className }: CardDescriptionProps): React.ReactElement {
  return <p className={cn('text-sm text-gray-400', className)}>{children}</p>;
}

export interface CardContentProps {
  children: React.ReactNode;
  className?: string;
}

export function CardContent({ children, className }: CardContentProps): React.ReactElement {
  return <div className={cn('', className)}>{children}</div>;
}

export interface CardFooterProps {
  children: React.ReactNode;
  className?: string;
}

export function CardFooter({ children, className }: CardFooterProps): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-3 pt-3 border-t border-white/5', className)}>
      {children}
    </div>
  );
}

export default Card;
