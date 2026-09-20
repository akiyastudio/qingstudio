export const host = window.photoFlowComponent;

export const uiContractVersion = 1;

export const applyUiTheme = (resolvedTheme, root = document.documentElement) => {
  const dark = resolvedTheme === 'dark';
  root.classList.toggle('dark', dark);
  root.dataset.photoflowTheme = dark ? 'dark' : 'light';
  return dark ? 'dark' : 'light';
};

export const mountUiTheme = async (root = document.documentElement) => {
  const context = await host.getContext();
  if (context.uiContractVersion !== uiContractVersion) throw new Error(`PhotoFlow UI contract ${uiContractVersion} is required; negotiated ${context.uiContractVersion || 'unknown'}`);
  applyUiTheme(context.resolvedTheme, root);
  return host.onThemeChange(value => applyUiTheme(value.resolvedTheme, root));
};

export const assertHostApi = context => { if (!context || typeof context !== 'object') { const error = new Error('PhotoFlow Host API context is required'); error.code = 'COMPONENT_HOST_API_UNAVAILABLE'; throw error; } };

export const mountUiLanguage = async (onChange = () => {}, root = document.documentElement) => {
  let currentLocale;
  const apply = context => { const locale = context.locale || 'zh-CN'; if (locale === currentLocale) return; currentLocale = locale; root.lang = locale; root.dir = /^(ar|fa|he|ur)(-|$)/i.test(locale) ? 'rtl' : 'ltr'; onChange(locale); };
  // Subscribe before reading the snapshot so changes during startup are not lost.
  let received = false;
  const subscribe = typeof host.onLocaleChange === 'function' ? host.onLocaleChange.bind(host) : host.onContextChange.bind(host);
  const unsubscribe = subscribe(context => { received = true; apply(context); });
  try { const context = await host.getContext(); if (!received) apply(context); }
  catch (error) { unsubscribe(); throw error; }
  return unsubscribe;
};
