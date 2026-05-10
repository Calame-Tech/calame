import React, { useEffect, useRef } from 'react';

export interface AddSourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (kind: 'databases' | 'knowledge') => void;
  ragEnabled: boolean;
  ragDisabledReason?: string | null;
}

// Database / cylinder icon
const IconDatabase = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-8 h-8"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"
    />
  </svg>
);

// Book / knowledge icon
const IconBookOpen = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-8 h-8"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25"
    />
  </svg>
);

export default function AddSourceModal({
  isOpen,
  onClose,
  onSelect,
  ragEnabled,
  ragDisabledReason,
}: AddSourceModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Trap focus inside modal when open
  useEffect(() => {
    if (isOpen && dialogRef.current) {
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      focusable[0]?.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const kbDisabledTitle = ragDisabledReason ?? 'Knowledge base features are unavailable on this instance';

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      aria-modal="true"
      role="dialog"
      aria-labelledby="add-source-modal-title"
      onClick={(e) => {
        // Close when clicking the overlay background
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Panel */}
      <div
        ref={dialogRef}
        className="relative w-full max-w-md mx-4 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-6 animate-fade-in-up"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2
            id="add-source-modal-title"
            className="text-base font-semibold text-gray-100"
          >
            Add a source
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors focus:outline-none focus:ring-2 focus:ring-os-500"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-400 mb-5">
          Choose the type of data source you want to connect.
        </p>

        {/* Kind picker cards */}
        <div className="grid grid-cols-2 gap-3">
          {/* Database card — always enabled */}
          <button
            type="button"
            onClick={() => onSelect('databases')}
            className="flex flex-col items-center gap-3 p-5 rounded-xl border border-gray-700 bg-gray-800/50 hover:border-os-500 hover:bg-os-500/5 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-os-500 group"
          >
            <span className="text-gray-400 group-hover:text-os-400 transition-colors">
              {IconDatabase}
            </span>
            <div className="text-center">
              <p className="text-sm font-medium text-gray-200 group-hover:text-os-300 transition-colors">
                Database
              </p>
              <p className="text-xs text-gray-500 mt-0.5">PostgreSQL, MySQL, SQLite</p>
            </div>
          </button>

          {/* Knowledge base card — disabled when ragEnabled is false */}
          {ragEnabled ? (
            <button
              type="button"
              onClick={() => onSelect('knowledge')}
              className="flex flex-col items-center gap-3 p-5 rounded-xl border border-gray-700 bg-gray-800/50 hover:border-os-500 hover:bg-os-500/5 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-os-500 group"
            >
              <span className="text-gray-400 group-hover:text-os-400 transition-colors">
                {IconBookOpen}
              </span>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-200 group-hover:text-os-300 transition-colors">
                  Knowledge base
                </p>
                <p className="text-xs text-gray-500 mt-0.5">Documents &amp; RAG</p>
              </div>
            </button>
          ) : (
            <div
              title={kbDisabledTitle}
              aria-disabled="true"
              className="flex flex-col items-center gap-3 p-5 rounded-xl border border-gray-800 bg-gray-900/50 cursor-not-allowed opacity-50"
            >
              <span className="text-gray-600">{IconBookOpen}</span>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-500">Knowledge base</p>
                <p className="text-xs text-gray-600 mt-0.5">Documents &amp; RAG</p>
              </div>
              <span
                className="text-[10px] text-gray-600 select-none"
                aria-hidden="true"
              >
                Not available
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
