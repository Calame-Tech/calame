/**
 * UI primitives barrel — import from this file for clean usage:
 *   import { Button, Card, Badge } from '../components/ui/index.js';
 */

// Utility
export { cn } from './cn.js';

// Atoms
export { Skeleton } from './Skeleton.js';
export type { SkeletonProps } from './Skeleton.js';

export { Badge } from './Badge.js';
export type { BadgeProps, BadgeVariant, BadgeSize } from './Badge.js';

export { Button } from './Button.js';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button.js';

export { Input } from './Input.js';
export type { InputProps } from './Input.js';

export { Select } from './Select.js';
export type { SelectProps } from './Select.js';

// Compositions
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './Card.js';
export type {
  CardProps,
  CardHeaderProps,
  CardTitleProps,
  CardDescriptionProps,
  CardContentProps,
  CardFooterProps,
} from './Card.js';

export { StatCard } from './StatCard.js';
export type { StatCardProps, StatCardTrend } from './StatCard.js';

// Layout helpers
export { EmptyState } from './EmptyState.js';
export type { EmptyStateProps } from './EmptyState.js';

export { PageHeader } from './PageHeader.js';
export type { PageHeaderProps, BreadcrumbItem } from './PageHeader.js';

export { Breadcrumb } from './Breadcrumb.js';
export type { BreadcrumbProps } from './Breadcrumb.js';

// Design system primitives
export { Eyebrow } from './Eyebrow.js';
export type {} from './Eyebrow.js';

export { SegmentedControl } from './SegmentedControl.js';
export type { SegmentOption } from './SegmentedControl.js';

export { KpiCard } from './KpiCard.js';
export type {} from './KpiCard.js';
