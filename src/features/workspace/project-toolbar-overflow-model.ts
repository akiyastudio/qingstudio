export const PROJECT_TOOLBAR_PRIMARY_OVERFLOW_WIDTH = 1040;
export const PROJECT_TOOLBAR_CONTEXTUAL_OVERFLOW_WIDTH = 760;
export const PROJECT_TOOLBAR_SELECTION_CONTEXTUAL_OVERFLOW_WIDTH = 900;

export interface ProjectToolbarOverflowInput {
  primary: readonly string[];
  contextual: readonly string[];
  components: readonly string[];
}

export interface ProjectToolbarOverflowState {
  visible: string[];
  overflow: string[];
}

/** Mirrors the toolbar container-query tiers without knowing any component IDs. */
export const resolveProjectToolbarOverflow = (availableWidth: number, input: ProjectToolbarOverflowInput, selectionActive = false): ProjectToolbarOverflowState => {
  const primaryOverflow = availableWidth <= PROJECT_TOOLBAR_PRIMARY_OVERFLOW_WIDTH;
  const contextualOverflow = availableWidth <= PROJECT_TOOLBAR_CONTEXTUAL_OVERFLOW_WIDTH
    || selectionActive && availableWidth <= PROJECT_TOOLBAR_SELECTION_CONTEXTUAL_OVERFLOW_WIDTH;
  const visible = [
    ...(primaryOverflow ? [] : input.primary),
    ...(contextualOverflow ? [] : input.contextual),
    ...(contextualOverflow ? [] : input.components),
  ];
  const overflow = [
    ...(primaryOverflow ? input.primary : []),
    ...(contextualOverflow ? input.contextual : []),
    ...(contextualOverflow ? input.components : []),
  ];
  return { visible, overflow };
};
