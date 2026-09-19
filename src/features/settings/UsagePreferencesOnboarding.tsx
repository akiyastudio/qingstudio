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
          <div><p className="usage-onboarding__eyebrow">照片流 · 初始偏好</p><h1>设置常用操作习惯</h1></div>
        </div>
        <div className="usage-onboarding__header-bottom">
          <p>完成初始设置，之后可随时修改。</p>
          <div className="usage-onboarding__progress" aria-label={`已完成 ${completedCount} 项，共 3 项`}><span>{completedCount} / 3</span><div>{[0, 1, 2].map(index => <i key={index} className={index < completedCount ? 'is-complete' : ''}/>)}</div></div>
        </div>
      </header>

      <div className="usage-onboarding__body">
        <PreferenceSection number="1" label="文件浏览" title="你习惯怎样打开文件？" description="此设置适用于所有文件。" complete={openModeComplete}>
          <div role="radiogroup" aria-label="打开文件和文件夹的方式" className="usage-preference-grid">
            <Choice selected={openMode === 'single'} title="单击打开" description="单击打开文件夹或预览媒体。" onClick={() => setOpenMode('single')}><MousePointerClick size={19}/></Choice>
            <Choice selected={openMode === 'double'} title="双击打开" description="单击选择，双击打开。" onClick={() => setOpenMode('double')}><MousePointerClick size={19}/></Choice>
          </div>
        </PreferenceSection>

        <PreferenceSection number="2" label="SD 卡导入" title="你通常怎样使用存储卡？" description="我们会据此设置默认读取范围和导入后的源文件处理方式。" complete={sdHabitComplete}>
          <div role="radiogroup" aria-label="SD 卡使用习惯" className="usage-preference-grid">
            <Choice selected={sdHabit === 'keep-many'} title="卡里长期保留素材" description="只读取最近拍摄的内容，并默认保留卡内原文件。" onClick={() => setSdHabit('keep-many')}><MemoryStick size={19}/></Choice>
            <Choice selected={sdHabit === 'clear-after-shoot'} title="每次拍摄后清卡" description="读取卡内全部内容，导入完成后默认删除源文件。" onClick={() => setSdHabit('clear-after-shoot')}><MemoryStick size={19}/></Choice>
          </div>
          {sdHabit === 'keep-many' && <div className="usage-preference-followup"><span>默认读取范围</span><div role="radiogroup" aria-label="SD 卡读取时间范围"><button type="button" role="radio" aria-checked={limitedDateFilter === 'today'} onClick={() => setLimitedDateFilter('today')} className={limitedDateFilter === 'today' ? 'is-selected' : ''}>仅今天</button><button type="button" role="radio" aria-checked={limitedDateFilter === 'today_yesterday'} onClick={() => setLimitedDateFilter('today_yesterday')} className={limitedDateFilter === 'today_yesterday' ? 'is-selected' : ''}>今天和昨天</button></div></div>}
        </PreferenceSection>

        <PreferenceSection number="3" label="图片筛选" title="你会使用图片星级吗？" description="两种模式都会直接读写图片自身的评分元数据。" complete={ratingHabitComplete}>
          <div role="radiogroup" aria-label="图片评分习惯" className="usage-preference-grid">
            <Choice selected={ratingHabit === 'stars'} title="一星到五星" description="显示完整五级评分，适合有精细筛选习惯的工作流。" onClick={() => setRatingHabit('stars')}><Star size={19} fill="currentColor"/></Choice>
            <Choice selected={ratingHabit === 'binary'} title="喜欢 / 不喜欢" description="只显示喜欢状态；点喜欢时在元数据中写入五星。" onClick={() => setRatingHabit('binary')}><Heart size={19} fill="currentColor"/></Choice>
          </div>
        </PreferenceSection>
      </div>

      <footer className="usage-onboarding__footer">
        <div>{error ? <p role="alert" className="usage-onboarding__error">{error}</p> : <p><strong>{complete ? '设置完成' : `还需完成 ${3 - completedCount} 项`}</strong><span>以后可在“设置 → 界面 / 导入”中修改</span></p>}</div>
        <button type="button" disabled={!complete || saving} onClick={() => void save()} className="usage-onboarding__submit"><span>{saving ? '正在保存…' : '保存并进入软件'}</span>{!saving && <ArrowRight size={17}/>}</button>
      </footer>
    </div>
  </main>;
};
