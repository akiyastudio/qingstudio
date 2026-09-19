type Props = {
  value: number;
  minimumVisible?: number;
  trackClassName: string;
  barClassName: string;
};

export const ProgressBar = ({ value, minimumVisible = 0, trackClassName, barClassName }: Props) => {
  const determinate = Number.isFinite(value);
  const normalized = Math.min(100, Math.max(0, determinate ? value : 0));
  const percentage = normalized > 0 ? Math.max(minimumVisible, normalized) : 0;
  return <div role="progressbar" aria-label={determinate ? '进度' : '正在处理'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={determinate ? normalized : undefined} className={trackClassName}><div className={barClassName} style={{ width: `${percentage}%` }}/></div>;
};
