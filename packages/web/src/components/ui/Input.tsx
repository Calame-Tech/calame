import React, { forwardRef } from 'react';
import { cn } from './cn.js';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

/**
 * Accessible text input with optional label, icons, error and hint states.
 * Supports forwardRef for form library integration.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, leftIcon, rightIcon, className, id, ...rest },
  ref,
) {
  // Generate a stable fallback id so label htmlFor always links to input
  const inputId = id ?? (label ? `input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);

  const hasError = Boolean(error);

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-gray-300">
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

        <input
          ref={ref}
          id={inputId}
          aria-invalid={hasError}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className={cn(
            'w-full px-3 py-2 text-sm bg-gray-900/60 border border-gray-700 rounded-lg',
            'text-gray-100 placeholder-gray-500',
            'focus:outline-none focus:ring-2 focus:ring-os-400 focus:border-transparent transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            hasError && 'border-red-500 focus:ring-red-400',
            leftIcon !== undefined ? 'pl-10' : '',
            rightIcon !== undefined ? 'pr-10' : '',
            className,
          )}
          {...rest}
        />

        {rightIcon && (
          <div
            className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-gray-500"
            aria-hidden="true"
          >
            {rightIcon}
          </div>
        )}
      </div>

      {error && (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {hint && !error && (
        <p id={`${inputId}-hint`} className="text-xs text-gray-500 mt-1">
          {hint}
        </p>
      )}
    </div>
  );
});

export default Input;
