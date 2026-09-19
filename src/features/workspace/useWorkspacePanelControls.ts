import { usePublishWorkspacePanels } from '../../platform/workspace-panel-registry';
import { DEFAULT_PANEL_WIDTHS, WORKSPACE_PANEL_IDS, WORKSPACE_PANEL_LABELS, type WorkspacePanelId, type WorkspacePanelWidths } from './workspace-panel-model';

export type PanelControl = { open: boolean; pinned: boolean; setOpen: (value: boolean) => void; setPinned: (value: boolean) => void; setSuppressed?: (value: boolean) => void; label?: string };
export const useWorkspacePanelControls = ({ pageId, active, order, setOrder, setWidths, files, preview, metadata, extra = {} }: {
  pageId: string; active: boolean; order: WorkspacePanelId[];
  setOrder: (order: WorkspacePanelId[]) => void;
  setWidths: (widths: WorkspacePanelWidths) => void;
  files: PanelControl; preview: PanelControl; metadata: PanelControl;
  extra?: Partial<Record<WorkspacePanelId, PanelControl>>;
}) => {
  const controls: Partial<Record<WorkspacePanelId, PanelControl>> = { ...extra, files, preview, metadata };
  const setVisible = (id: WorkspacePanelId, visible: boolean) => {
    const panel = controls[id];
    if (!panel) return;
    if (!visible) panel.setPinned(false);
    panel.setSuppressed?.(!visible);
    panel.setOpen(visible);
  };
  const setPinned = (id: WorkspacePanelId, pinned: boolean) => {
    const panel = controls[id];
    if (!panel) return;
    panel.setPinned(pinned);
    panel.setSuppressed?.(false);
    if (pinned) panel.setOpen(true);
  };
  usePublishWorkspacePanels(active, {
    pageId,
    panels: order.filter(id => controls[id]).map(id => ({ id, label: controls[id]!.label || WORKSPACE_PANEL_LABELS[id] || id, visible: controls[id]!.open, pinned: controls[id]!.pinned })),
    setVisible, setPinned,
    reset: () => {
      setOrder([...WORKSPACE_PANEL_IDS, ...Object.keys(extra) as WorkspacePanelId[]]); setWidths({ ...DEFAULT_PANEL_WIDTHS });
      for (const id of WORKSPACE_PANEL_IDS) setPinned(id, true);
      for (const id of Object.keys(extra) as WorkspacePanelId[]) { setPinned(id, false); setVisible(id, true); }
    },
  });
  return {
    closePreviewPaneByUser: () => setVisible('preview', false),
    closeMetadataPaneByUser: () => setVisible('metadata', false),
    togglePreviewPanePinned: () => setPinned('preview', !preview.pinned),
    toggleMetadataPanePinned: () => setPinned('metadata', !metadata.pinned),
  };
};
