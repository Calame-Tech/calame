import type { ReactNode } from 'react';

interface EyebrowProps {
  children: ReactNode;
  accent?: boolean;
  live?: boolean;
  dotColor?: string;
  className?: string;
}

export function Eyebrow({ children, accent, live, dotColor, className = '' }: EyebrowProps) {
  const base = accent ? 'eyebrow-accent' : 'eyebrow';
  return (
    <span className={`inline-flex items-center gap-1.5 ${base} ${className}`}>
      {(live || dotColor) && (
        <span
          className={`w-1.5 h-1.5 rounded-full ${dotColor ?? 'bg-emerald-400'} ${live ? 'animate-pulse' : ''}`}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

export default Eyebrow;
