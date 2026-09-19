type PanelSwitchProps = {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
};

export const PanelSwitch = ({ title, description, checked, disabled = false, onChange, className = '' }: PanelSwitchProps) => (
  <section className={`flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3 ${disabled ? 'opacity-50' : ''} ${className}`}>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-bold text-slate-700">{title}</p>
      {description && <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`import-source-switch flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed ${checked ? 'is-on' : ''}`}
    >
      <span className={`import-source-switch-thumb h-4 w-4 shrink-0 rounded-full shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}/>
    </button>
  </section>
);
