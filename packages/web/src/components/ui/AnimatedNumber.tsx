import { useEffect, useRef, useState } from 'react';

/** Cubic ease-out — matches the "confident arrival" curve used elsewhere in
 * this app's CSS (`cubic-bezier(0.16, 1, 0.3, 1)`), reimplemented in JS since
 * a numeric tween needs an intermediate value every frame, not just a start
 * and end keyframe. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * Tweens a raw number from its previous value to a new one whenever `value`
 * changes, instead of snapping — the shared engine behind {@link AnimatedNumber}.
 * Exposed as its own hook so numbers that can't be wrapped in a React element
 * (SVG `<text>` content, which only accepts text/tspan children) can still
 * animate: read the returned number and format it directly into the string.
 *
 * Deliberately does NOT animate the very first render (no count-up-from-zero
 * on page load — Operate-mode surfaces shouldn't make the user wait through
 * load choreography for a number they came to read).
 */
export function useAnimatedNumber(value: number, durationMs = 600): number {
  const [displayed, setDisplayed] = useState(value);
  const hasMountedRef = useRef(false);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      fromRef.current = value;
      setDisplayed(value);
      return;
    }
    if (fromRef.current === value) return;

    if (prefersReducedMotion()) {
      fromRef.current = value;
      setDisplayed(value);
      return;
    }

    const from = fromRef.current;
    const to = value;
    const start = performance.now();

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setDisplayed(from + (to - from) * easeOutCubic(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value]);

  return displayed;
}

interface AnimatedNumberProps {
  /** Target numeric value to display. */
  value: number;
  /** Formats the (possibly mid-tween) number for display. Defaults to `Math.round(n).toLocaleString()`. */
  format?: (n: number) => string;
  durationMs?: number;
  className?: string;
}

/**
 * Tweens its displayed text from the previous value to a new one whenever
 * `value` changes — e.g. a KPI ticking to its latest number on a live
 * metrics refresh, instead of silently snapping.
 */
export function AnimatedNumber({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  durationMs = 600,
  className,
}: AnimatedNumberProps) {
  const displayed = useAnimatedNumber(value, durationMs);
  return <span className={className}>{format(displayed)}</span>;
}

export default AnimatedNumber;
