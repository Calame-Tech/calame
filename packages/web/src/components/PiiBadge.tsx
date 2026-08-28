import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'use-intl/react';
import type { PiiDetection, PiiCategory } from '../types/schema.js';

const CONFIDENCE_CLASSES: Record<PiiDetection['confidence'], string> = {
  high: 'bg-orange-500/15 text-orange-400 ring-orange-500/25',
  medium: 'bg-amber-500/15 text-amber-400 ring-amber-500/25',
  low: 'bg-gray-500/15 text-gray-400 ring-gray-500/25',
  manual: 'bg-indigo-500/15 text-indigo-400 ring-indigo-500/25',
};

export const ALL_PII_CATEGORIES: PiiCategory[] = [
  'email',
  'phone',
  'name',
  'address',
  'credit_card',
  'password',
  'ip_address',
  'ssn',
  'encrypted',
];

interface PiiBadgeProps {
  detection: PiiDetection;
  /** If provided, the badge becomes editable: click to change category, or remove. */
  onChangeCategory?: (category: PiiCategory) => void;
  onRemove?: () => void;
}

export default function PiiBadge({ detection, onChangeCategory, onRemove }: PiiBadgeProps) {
  const t = useTranslations('settingsPanels.pii');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const categoryLabel = (cat: PiiCategory) =>
    ALL_PII_CATEGORIES.includes(cat) ? t(`categoryLabels.${cat}`) : cat;
  const label = categoryLabel(detection.category);
  const isManual = detection.matchedBy === 'manual';
  const classes = CONFIDENCE_CLASSES[detection.confidence];
  const editable = onChangeCategory || onRemove;

  const confidenceLabel: Record<PiiDetection['confidence'], string> = {
    high: t('confidenceLabels.high'),
    medium: t('confidenceLabels.medium'),
    low: t('confidenceLabels.low'),
    manual: t('confidenceLabels.manual'),
  };

  const categoryDescription = (cat: PiiCategory) =>
    ALL_PII_CATEGORIES.includes(cat) ? t(`categoryDescriptions.${cat}`) : cat;

  const tooltipText = isManual
    ? t('tooltip.manual', {
        description: categoryDescription(detection.category),
        confidence: confidenceLabel.manual,
      }) + (editable ? t('tooltip.clickToEdit') : '')
    : t('tooltip.detectedBy', {
        description: categoryDescription(detection.category),
        confidence: confidenceLabel[detection.confidence],
        matchedBy: detection.matchedBy,
      }) + (editable ? t('tooltip.clickToEdit') : '');

  return (
    <div className="relative inline-block" ref={ref}>
      <span
        onClick={() => editable && setOpen(!open)}
        title={tooltipText}
        className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ring-1 ${classes} ${editable ? 'cursor-pointer hover:brightness-125' : ''}`}
      >
        {t('badgeLabel', { label })}
      </span>

      {open && editable && (
        <div className="absolute z-50 top-full left-0 mt-1 bg-gray-900/95 border border-white/10 rounded-lg shadow-xl py-1 min-w-[120px]">
          {ALL_PII_CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => {
                onChangeCategory?.(cat);
                setOpen(false);
              }}
              className={`block w-full text-left px-3 py-1 text-xs hover:bg-gray-800 transition-colors ${
                cat === detection.category ? 'text-os-400 font-medium' : 'text-gray-300'
              }`}
            >
              {categoryLabel(cat)}
            </button>
          ))}
          {onRemove && (
            <>
              <div className="border-t border-white/5 my-1" />
              <button
                onClick={() => {
                  onRemove();
                  setOpen(false);
                }}
                className="block w-full text-left px-3 py-1 text-xs text-red-400 hover:bg-gray-800 transition-colors"
              >
                {t('removeTag')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
