import { useState, useRef, useEffect, useCallback } from 'react';

export interface DarkSelectOption {
  value: string;
  label: string;
  hint?: string;
}

interface DarkSelectProps {
  value: string;
  options: DarkSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  size?: 'xs' | 'sm';
}

/**
 * Compact dark-themed dropdown that replaces native <select>. The native control
 * paints its <option> list with the OS color scheme (white on grey), which clashes
 * with the rest of the editorial dark UI — this component renders the popover in
 * gray-900 with hover states matching the brand os-* palette.
 */
export default function DarkSelect({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Select…',
  ariaLabel,
  className = '',
  size = 'sm',
}: DarkSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const selected = options.find((o) => o.value === value);

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const sizeClasses = size === 'xs' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm';

  return (
    <div ref={wrapperRef} className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`inline-flex items-center justify-between gap-2 rounded-lg bg-gray-900 border border-gray-700 text-gray-100 hover:border-gray-600 focus:outline-none focus:ring-2 focus:ring-os-500/40 focus:border-os-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors w-full ${sizeClasses}`}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <span
          aria-hidden="true"
          className={`text-gray-500 transition-transform duration-150 shrink-0 ${
            open ? 'rotate-180' : ''
          }`}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-20 mt-1 w-full min-w-[10rem] rounded-lg border border-white/10 bg-gray-900 shadow-xl shadow-black/40 overflow-hidden animate-fade-in-up"
        >
          <ul className="max-h-64 overflow-y-auto py-1">
            {options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <li key={opt.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(opt.value);
                      close();
                      buttonRef.current?.focus();
                    }}
                    className={`w-full text-left px-3 py-1.5 text-sm transition-colors flex items-center justify-between gap-2 ${
                      isSelected
                        ? 'bg-os-700/30 text-os-300'
                        : 'text-gray-200 hover:bg-gray-800/70'
                    }`}
                  >
                    <span className="truncate">
                      {opt.label}
                      {opt.hint && (
                        <span className="text-xs text-gray-500 ml-1.5">{opt.hint}</span>
                      )}
                    </span>
                    {isSelected && (
                      <span aria-hidden="true" className="text-os-400 text-xs shrink-0">
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {options.length === 0 && (
              <li className="px-3 py-2 text-xs text-gray-500 italic">No option available</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
