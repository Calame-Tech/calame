import type { ReactNode } from 'react';

type AccentColor = 'indigo' | 'emerald' | 'amber' | 'blue' | 'purple' | 'cyan' | 'rose';

const accentBg: Record<AccentColor, string> = {
  indigo: 'bg-os-500/10',
  emerald: 'bg-emerald-500/10',
  amber: 'bg-amber-500/10',
  blue: 'bg-blue-500/10',
  purple: 'bg-purple-500/10',
  cyan: 'bg-cyan-500/10',
  rose: 'bg-rose-500/10',
};

interface KpiCardProps {
  eyebrow: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  accent?: AccentColor;
  decoration?: ReactNode;
  footer?: ReactNode;
  onClick?: () => void;
  className?: string;
}

export function KpiCard({
  eyebrow,
  value,
  hint,
  accent = 'indigo',
  decoration,
  footer,
  onClick,
  className = '',
}: KpiCardProps) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      onClick={onClick}
      className={`group relative card-interactive overflow-hidden text-left w-full ${className}`}
    >
      <div
        className={`pointer-events-none absolute -top-10 -right-10 w-32 h-32 rounded-full blur-3xl opacity-40 ${accentBg[accent]}`}
        aria-hidden="true"
      />
      <div className="relative p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="eyebrow">{eyebrow}</div>
          {decoration}
        </div>
        <div className="font-display font-light text-4xl leading-none tracking-tight text-gray-100">
          {value}
        </div>
        {hint && <p className="mt-1.5 text-sm text-gray-500">{hint}</p>}
      </div>
      {footer && <div className="relative hairline px-4 py-2.5">{footer}</div>}
    </Wrapper>
  );
}

export default KpiCard;
