import React, { forwardRef } from 'react';
import { cn } from './cn.js';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
}

/** Chevron-down icon rendered as an absolute-positioned SVG */
function ChevronDown(): React.ReactElement {
  return (
    <svg
      className="h-4 w-4 text-gray-500 pointer-events-none"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Native select element styled to match the dark theme, with optional label,
 * left icon, error and hint states. Supports forwardRef.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, hint, leftIcon, className, id, children, ...rest },
  ref,
) {
  const selectId = id ?? (label ? `select-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);

  const hasError = Boolean(error);

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-gray-300">
          {label}
        </label>
      )}

      <div className="relative">
        {leftIcon && (
          <div
            className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-gray-500"
            aria-hidden="true"
          >
            {leftIcon}
          </div>
        )}

        <select
          ref={ref}
          id={selectId}
          aria-invalid={hasError}
          aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
          className={cn(
            'w-full appearance-none px-3 py-2 text-sm bg-gray-900/60 border border-gray-700 rounded-lg',
            'text-gray-100',
            'focus:outline-none focus:ring-2 focus:ring-os-400 focus:border-transparent transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            hasError && 'border-red-500 focus:ring-red-400',
            leftIcon ? 'pl-10' : '',
            // Always reserve space for chevron on the right
            'pr-10',
            className,
          )}
          {...rest}
        >
          {children}
        </select>

        {/* Chevron overlay */}
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
          <ChevronDown />
        </div>
      </div>

      {error && (
        <p id={`${selectId}-error`} role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {hint && !error && (
        <p id={`${selectId}-hint`} className="text-xs text-gray-500 mt-1">
          {hint}
        </p>
      )}
    </div>
  );
});

export default Select;
