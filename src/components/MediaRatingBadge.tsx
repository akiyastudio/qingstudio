import { Heart, Star } from 'lucide-react';
import { useLocale } from '../i18n/react';
import { t } from '../i18n/runtime';
import type { AppConfig } from '../types';

export function MediaRatingBadge({ rating, mode, large = false }: { rating: number; mode: AppConfig['favoriteDisplayMode']; large?: boolean }) {
  useLocale();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  const stars = mode === 'stars';
  const label = stars ? t('ui.image.rating.value0.stars.f218de', { value0: rating }) : t('ui.liked.6c3244');
  const Icon = stars ? Star : Heart;
  return <span
    role="img"
    aria-label={label}
    title={label}
    className={`pointer-events-none absolute z-10 inline-flex items-center gap-1 rounded bg-slate-950/80 font-bold shadow-sm ${large ? 'bottom-2 right-2 px-1.5 py-1 text-xs' : 'bottom-0.5 right-0.5 px-1 py-0.5 text-[10px]'} ${stars ? 'text-amber-300' : 'text-rose-400'}`}
  >
    <Icon size={large ? 14 : 10} fill="currentColor" aria-hidden="true"/>
    {stars && <span aria-hidden="true">{rating}</span>}
  </span>;
}
