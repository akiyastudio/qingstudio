/** Public metadata from CloudBase; installation and runtime discovery remain local. */
export interface CatalogPlugin {
  id: string;
  name: string;
  homepage: string;
  latestVersion: string;
  capabilities: string[];
  formats: string[];
  previewPromptEnabled: boolean;
}
