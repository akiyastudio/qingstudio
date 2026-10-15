import type { CatalogPlugin } from '../../contracts/plugin-catalog';
import type { PreviewDecoder } from '../../contracts/component-preview';

export const previewPluginForFile = (plugins: CatalogPlugin[], name: string, decoders: PreviewDecoder[], installedIds: ReadonlySet<string>): CatalogPlugin | undefined => {
  const extension = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  if (decoders.some(decoder => decoder.extensions.some(format => format === '*' || format.toLowerCase() === `.${extension}`))) return undefined;
  return plugins.find(plugin => plugin.previewPromptEnabled === true
    && plugin.capabilities.includes('preview')
    && plugin.formats.some(format => format.replace(/^\./, '').toLowerCase() === extension)
    && !installedIds.has(plugin.id));
};
