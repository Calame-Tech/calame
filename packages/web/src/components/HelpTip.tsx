import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

interface HelpTipProps {
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  maxWidth?: number;
  /** Size variant: 'sm' (default) or 'xs' for tighter spaces */
  size?: 'sm' | 'xs';
}

/**
 * Small "?" icon that reveals a tooltip on hover.
 * Place next to labels, headers or buttons that need explanation.
 */
export default function HelpTip({
  content,
  position = 'top',
  maxWidth = 260,
  size = 'sm',
}: HelpTipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const ref = useRef<HTMLSpanElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const show = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const gap = 6;
      let top = 0;
      let left = 0;
      switch (position) {
        case 'top':
          top = rect.top - gap;
          left = rect.left + rect.width / 2;
          break;
        case 'bottom':
          top = rect.bottom + gap;
          left = rect.left + rect.width / 2;
          break;
        case 'left':
          top = rect.top + rect.height / 2;
          left = rect.left - gap;
          break;
        case 'right':
          top = rect.top + rect.height / 2;
          left = rect.right + gap;
          break;
      }
      setCoords({ top, left });
      setVisible(true);
    }, 300);
  };

  const hide = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  const positionClasses: Record<string, string> = {
    top: '-translate-x-1/2 -translate-y-full',
    bottom: '-translate-x-1/2',
    left: '-translate-x-full -translate-y-1/2',
    right: '-translate-y-1/2',
  };

  const arrowClasses: Record<string, string> = {
    top: 'left-1/2 -translate-x-1/2 -bottom-1 border-l-transparent border-r-transparent border-b-transparent border-t-gray-800',
    bottom: 'left-1/2 -translate-x-1/2 -top-1 border-l-transparent border-r-transparent border-t-transparent border-b-gray-800',
    left: 'top-1/2 -translate-y-1/2 -right-1 border-t-transparent border-b-transparent border-r-transparent border-l-gray-800',
    right: 'top-1/2 -translate-y-1/2 -left-1 border-t-transparent border-b-transparent border-l-transparent border-r-gray-800',
  };

  const sizeClasses = size === 'xs'
    ? 'w-3 h-3 text-[8px]'
    : 'w-3.5 h-3.5 text-[9px]';

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Escape') hide();
  };

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        className={`inline-flex items-center justify-center ${sizeClasses} rounded-full border border-gray-600 text-gray-500 hover:text-gray-300 hover:border-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 cursor-help transition-colors flex-shrink-0 select-none`}
        aria-label="Help"
      >
        ?
      </span>
      {visible && createPortal(
        <div
          role="tooltip"
          className={`fixed z-[9999] px-3 py-2 text-xs leading-relaxed text-gray-200 bg-gray-800 border border-gray-700 rounded-lg shadow-xl ${positionClasses[position]} pointer-events-none`}
          style={{ top: coords.top, left: coords.left, maxWidth }}
        >
          {content}
          <span className={`absolute w-0 h-0 border-4 ${arrowClasses[position]}`} />
        </div>,
        document.body,
      )}
    </>
  );
}
