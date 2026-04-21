/**
 * Lightweight class name utility — avoids adding a `clsx` dependency.
 * Filters out falsy values and joins the remaining strings.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}
