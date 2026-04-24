import React, { forwardRef } from 'react';
import { cn } from './cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /** Shows a spinner and disables the button */
  loading?: boolean;
  fullWidth?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-os-500 hover:bg-os-400 text-white focus:ring-2 focus:ring-os-400 focus:ring-offset-2 focus:ring-offset-gray-900',
  secondary:
    'bg-gray-800 hover:bg-gray-700 text-gray-100 border border-gray-700 focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-gray-900',
  ghost: 'text-gray-300 hover:text-gray-100 hover:bg-gray-800/60',
  danger:
    'bg-red-600 hover:bg-red-500 text-white focus:ring-2 focus:ring-red-400 focus:ring-offset-2 focus:ring-offset-gray-900',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3 py-2 text-sm',
  lg: 'px-4 py-2 text-base',
};

/** Small inline spinner used in loading state */
function Spinner(): React.ReactElement {
  return (
    <svg
      className="animate-spin h-4 w-4"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

/**
 * Primary action button with multiple variants, sizes, and loading state.
 * Supports forwardRef for form library integration.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    leftIcon,
    rightIcon,
    loading = false,
    fullWidth = false,
    disabled,
    children,
    className,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      disabled={isDisabled}
      aria-busy={loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none',
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

export default Button;
