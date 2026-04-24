import React from 'react';
import { cn } from './cn.js';

export interface SkeletonProps {
  className?: string;
  width?: string | number;
  height?: string | number;
}

/**
 * Skeleton loading placeholder — uses Tailwind pulse animation.
 */
export function Skeleton({ className, width, height }: SkeletonProps): React.ReactElement {
  const style: React.CSSProperties = {};
  if (width !== undefined) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height;

  return (
    <div
      className={cn('animate-pulse rounded bg-white/5', className)}
      style={style}
      aria-hidden="true"
    />
  );
}

export default Skeleton;
