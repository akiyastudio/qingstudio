import { LocalizedText } from "../../i18n/LocalizedText";
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Heart, MemoryStick, MousePointerClick, Star } from 'lucide-react';
import type { AppConfig } from '../../types';

export const USAGE_PREFERENCES_VERSION = 1;

type OpenMode = AppConfig['itemOpenMode'];
type SdHabit = 'keep-many' | 'clear-after-shoot';
type LimitedDateFilter = 'today' | 'today_yesterday';
type RatingHabit = 'stars' | 'binary';

const Choice = ({ selected, title, description, onClick, children }: {
  selected: boolean;
  title: string;
  description: string;
  onClick: () => void;
  children: ReactNode;
}) => <button type="button" role="radio" aria-checked={selected} onClick={onClick} className={`usage-preference-choice ${selected ? 'is-selected' : ''}`}>
  <span className="usage-preference-choice__icon">{children}</span>
  <span className="usage-preference-choice__copy"><span className="usage-preference-choice__title">{title}</span><span className="usage-preference-choice__description">{description}</span></span>
  <span className="usage-preference-choice__check" aria-hidden="true"><Check size={13}/></span>
</button>;

const PreferenceSection = ({ number, label, title, description, complete, children }: {
  number: string;
  label: string;
  title: string;
  description: string;
  complete: boolean;
  children: ReactNode;
}) => <section className="usage-preference-section">
  <div className="usage-preference-section__intro">
    <div className="usage-preference-section__meta"><span className={`usage-preference-section__number ${complete ? 'is-complete' : ''}`}>{complete ? <Check size={14}/> : number}</span><span>{label}</span></div>
    <h2>{title}</h2>
    <p>{description}</p>
  </div>
  <div className="usage-preference-section__controls">{children}</div>
</section>;

export const UsagePreferencesOnboarding = ({ config, onSave }: { config: AppConfig; onSave: (nextConfig: AppConfig) => Promise<boolean> }) => {
  useLocale();
  const [openMode, setOpenMode] = useState<OpenMode | null>(null);
  const [sdHabit, setSdHabit] = useState<SdHabit | null>(null);
  const [limitedDateFilter, setLimitedDateFilter] = useState<LimitedDateFilter | null>(null);
  const [ratingHabit, setRatingHabit] = useState<RatingHabit | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const openModeComplete = Boolean(openMode);
  const sdHabitComplete = Boolean(sdHabit && (sdHabit === 'clear-after-shoot' || limitedDateFilter));
  const ratingHabitComplete = Boolean(ratingHabit);
  const completedCount = [openModeComplete, sdHabitComplete, ratingHabitComplete].filter(Boolean).length;
  const complete = Boolean(openMode && sdHabit && ratingHabit && (sdHabit === 'clear-after-shoot' || limitedDateFilter));

  const save = async () => {
    if (!complete || !openMode || !sdHabit || !ratingHabit || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    const keepMany = sdHabit === 'keep-many';
    const nextConfig: AppConfig = {
      ...config,
      usagePreferencesVersion: USAGE_PREFERENCES_VERSION,
      itemOpenMode: openMode,
      favoriteDisplayMode: ratingHabit,
      importDefaults: { ...config.importDefaults, deleteSourceAfterImport: !keepMany },
      smartImport: {
        ...config.smartImport,
        dateFilter: keepMany ? limitedDateFilter || 'today_yesterday' : 'all',
      },
    };
    try {
      const saved = await onSave(nextConfig);
      if (!saved) setError('设置没有保存成功，请重试。完成保存后才能进入照片流。');
    } catch (reason) {
      setError(`设置没有保存成功，请重试。${reason instanceof Error && reason.message ? `（${reason.message}）` : ''}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return <main className="usage-onboarding">
    <div className="usage-onboarding__ambient usage-onboarding__ambient--one"/>
    <div className="usage-onboarding__ambient usage-onboarding__ambient--two"/>
    <div className="usage-onboarding__panel">
      <header className="usage-onboarding__header">
        <div className="usage-onboarding__brand">
          <img src="./app-logo.svg" className="brand-logo usage-onboarding__logo" alt=""/>
          <div><p className="usage-onboarding__eyebrow">{t("ui.photoflow.initial.preferences.54e4d9")}</p><h1>{t("ui.set.your.preferences.999c7e")}</h1></div>
        </div>
        <div className="usage-onboarding__header-bottom">
          <p>{t("ui.complete.the.initial.setup.you.can.fcd81b")}</p>
          <div className="usage-onboarding__progress" aria-label={t("ui.completed.value0.of.3.steps.ed3be5", { value0: completedCount })}><span>{completedCount} / 3</span><div>{[0, 1, 2].map(index => <i key={index} className={index < completedCount ? 'is-complete' : ''}/>)}</div></div>
        </div>
      </header>

      <div className="usage-onboarding__body">
        <PreferenceSection number="1" label={t("ui.file.browsing.ad064e")} title={t("ui.how.do.you.prefer.to.open.2a1ca9")} description={t("ui.this.setting.applies.to.all.files.9f09f5")} complete={openModeComplete}>
          <div role="radiogroup" aria-label={t("ui.how.to.open.files.and.folders.4f7967")} className="usage-preference-grid">
            <Choice selected={openMode === 'single'} title={t("ui.single.click.to.open.44fd9b")} description={t("ui.click.once.to.open.folders.or.8ad681")} onClick={() => setOpenMode('single')}><MousePointerClick size={19}/></Choice>
            <Choice selected={openMode === 'double'} title={t("ui.double.click.to.open.1ad577")} description={t("ui.click.to.select.double.click.to.2734b4")} onClick={() => setOpenMode('double')}><MousePointerClick size={19}/></Choice>
          </div>
        </PreferenceSection>

        <PreferenceSection number="2" label={t("ui.sd.card.import.10b60b")} title={t("ui.how.do.you.usually.use.memory.287992")} description={t("ui.this.sets.the.default.import.range.307202")} complete={sdHabitComplete}>
          <div role="radiogroup" aria-label={t("ui.sd.card.preferences.5566b8")} className="usage-preference-grid">
            <Choice selected={sdHabit === 'keep-many'} title={t("ui.keep.media.on.the.card.c75cfe")} description={t("ui.import.recent.captures.and.keep.original.dd1349")} onClick={() => setSdHabit('keep-many')}><MemoryStick size={19}/></Choice>
            <Choice selected={sdHabit === 'clear-after-shoot'} title={t("ui.clear.the.card.after.each.shoot.f5a004")} description={t("ui.import.all.content.and.delete.source.a0bd3c")} onClick={() => setSdHabit('clear-after-shoot')}><MemoryStick size={19}/></Choice>
          </div>
          {sdHabit === 'keep-many' && <div className="usage-preference-followup"><span>{t("ui.default.import.range.f6e83f")}</span><div role="radiogroup" aria-label={t("ui.sd.card.date.range.0e6ca7")}><button type="button" role="radio" aria-checked={limitedDateFilter === 'today'} onClick={() => setLimitedDateFilter('today')} className={limitedDateFilter === 'today' ? 'is-selected' : ''}>{t("ui.today.only.8beb74")}</button><button type="button" role="radio" aria-checked={limitedDateFilter === 'today_yesterday'} onClick={() => setLimitedDateFilter('today_yesterday')} className={limitedDateFilter === 'today_yesterday' ? 'is-selected' : ''}>{t("ui.today.and.yesterday.bf1f7a")}</button></div></div>}
        </PreferenceSection>

        <PreferenceSection number="3" label={t("ui.image.selection.9ac774")} title={t("ui.do.you.use.star.ratings.df64ae")} description={t("ui.both.modes.read.and.write.the.95e083")} complete={ratingHabitComplete}>
          <div role="radiogroup" aria-label={t("ui.image.rating.preferences.b0af11")} className="usage-preference-grid">
            <Choice selected={ratingHabit === 'stars'} title={t("ui.one.to.five.stars.7f4752")} description={t("ui.show.all.five.stars.for.detailed.ab4617")} onClick={() => setRatingHabit('stars')}><Star size={19} fill="currentColor"/></Choice>
            <Choice selected={ratingHabit === 'binary'} title={t("ui.like.unlike.62a0cd")} description={t("ui.show.only.liked.status.liking.an.045e4d")} onClick={() => setRatingHabit('binary')}><Heart size={19} fill="currentColor"/></Choice>
          </div>
        </PreferenceSection>
      </div>

      <footer className="usage-onboarding__footer">
        <div>{error ? <p role="alert" className="usage-onboarding__error"><LocalizedText value={error}/></p> : <p><strong>{complete ? t("ui.setup.complete.0f7bdd") : t("ui.steps.remaining.value0.d6058b", { value0: 3 - completedCount })}</strong><span>{t("ui.change.these.later.in.settings.interface.a34873")}</span></p>}</div>
        <button type="button" disabled={!complete || saving} onClick={() => void save()} className="usage-onboarding__submit"><span>{saving ? t("ui.saving.6bdb44") : t("ui.save.and.continue.2e441d")}</span>{!saving && <ArrowRight size={17}/>}</button>
      </footer>
    </div>
  </main>;
};
