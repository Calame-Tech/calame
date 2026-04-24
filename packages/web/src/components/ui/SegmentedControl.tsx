import type { ReactNode } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: string;
}

interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
  size?: 'sm' | 'md';
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: SegmentedControlProps<T>) {
  const padding = size === 'sm' ? 'px-3 py-1' : 'px-4 py-1.5';
  return (
    <div
      className="inline-flex items-center bg-gray-900/60 border border-white/5 rounded-full p-1"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            title={opt.description}
            aria-pressed={active}
            className={`${padding} rounded-full font-mono-plex text-xs font-medium transition-all duration-200 focus:outline-none focus:ring-1 focus:ring-os-500/40 ${
              active
                ? 'bg-os-500/15 text-os-300 ring-1 ring-os-500/30'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
