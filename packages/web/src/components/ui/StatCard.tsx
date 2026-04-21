import React from 'react';
import { cn } from './cn.js';
import { Skeleton } from './Skeleton.js';

export interface StatCardTrend {
  /** Positive = up (green), negative = down (red) */
  value: number;
  label?: string;
}

export interface StatCardProps {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  trend?: StatCardTrend;
  loading?: boolean;
  className?: string;
}

/** Up-arrow SVG for positive trends */
function TrendUp(): React.ReactElement {
  return (
    <svg
      className="h-3.5 w-3.5"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Down-arrow SVG for negative trends */
function TrendDown(): React.ReactElement {
  return (
    <svg
      className="h-3.5 w-3.5"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Metric card showing a labelled numeric/string value with optional icon and trend.
 */
export function StatCard({
  label,
  value,
  icon,
  trend,
  loading = false,
  className,
}: StatCardProps): React.ReactElement {
  return (
    <div
      className={cn(
        'rounded-xl border border-gray-800/80 bg-gray-900/60 backdrop-blur-sm p-6',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-3 flex-1 min-w-0">
          {/* Label */}
          {loading ? (
            <Skeleton width={80} height={14} />
          ) : (
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider truncate">
              {label}
            </p>
          )}

          {/* Value */}
          {loading ? (
            <Skeleton width={100} height={36} />
          ) : (
            <p className="text-3xl font-bold text-gray-100 leading-none tabular-nums">{value}</p>
          )}

          {/* Trend */}
          {!loading && trend !== undefined && (
            <div
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                trend.value >= 0 ? 'text-emerald-400' : 'text-red-400',
              )}
              aria-label={`Trend: ${trend.value >= 0 ? '+' : ''}${trend.value}%${trend.label ? ` ${trend.label}` : ''}`}
            >
              {trend.value >= 0 ? <TrendUp /> : <TrendDown />}
              <span>
                {trend.value >= 0 ? '+' : ''}
                {trend.value}%{trend.label ? ` ${trend.label}` : ''}
              </span>
            </div>
          )}

          {loading && trend !== undefined && <Skeleton width={60} height={14} />}
        </div>

        {/* Icon — top-right */}
        {icon && (
          <div
            className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg bg-gray-800/60 text-gray-500"
            aria-hidden="true"
          >
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}

export default StatCard;
