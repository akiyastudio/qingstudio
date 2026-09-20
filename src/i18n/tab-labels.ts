import { t } from './runtime';
import { renderText } from './messages';
/** Tab kinds distinguish application captions from user project and folder names. */
export const workspaceTabLabel = (tab: { kind: string; label: string }): string => {
  if (tab.kind === 'home') return t("ui.home.3e0d67");
  if (tab.kind === 'settings') return t("ui.settings.df3d58");
  if (tab.kind === 'search-all') return t("ui.global.search.f1c10d");
  if (tab.kind === 'project') return tab.label;
  const separator = tab.label.indexOf(' · ');
  const prefix = separator >= 0 ? tab.label.slice(0, separator) : tab.label;
  const localizedPrefix = renderText(prefix);
  if (tab.kind === 'component') return localizedPrefix + (separator >= 0 ? tab.label.slice(separator) : '');
  const expected = tab.kind === 'inspiration' ? t("ui.inspiration.library.9ac871") : tab.kind === 'version' ? t("ui.version.5f76b2") : '';
  if (expected && localizedPrefix === expected) return expected + (separator >= 0 ? tab.label.slice(separator) : '');
  if (tab.kind === 'version' && renderText(tab.label) === t("ui.version.history.79b622")) return t("ui.version.history.79b622");
  return tab.label;
};
