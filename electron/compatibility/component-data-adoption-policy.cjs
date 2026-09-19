const rawDefaultPolicy = require('./component-data-adoption-policy.json');

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TOP_LEVEL_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
const RESERVED_TOP_LEVEL_CONFIG_KEYS = new Set(['componentSettings', 'componentSettingsRevisions', 'workspacePath', 'backup']);
const POLICY_INSTANCES = new WeakSet();

const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) throw new TypeError(`Invalid ${label} fields`);
};
const exactText = (value, pattern, label, maxLength = 512) => {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength || !pattern.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
};
const databasePath = value => {
  const text = exactText(value, /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\\/\u0000-\u001f]+(?:\/[^\\/\u0000-\u001f]+)*$/, 'legacy domain database path');
  if (text.includes('/')) throw new TypeError('Legacy domain database path must be a domain-database filename');
  return text;
};
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const createComponentDataAdoptionPolicy = value => {
  exactKeys(value, ['version', 'legacyDomainDatabaseOwners', 'legacySettingsAdoptions'], 'component data adoption policy');
  if (value.version !== 1) throw new TypeError('Unsupported component data adoption policy version');
  if (!Array.isArray(value.legacyDomainDatabaseOwners) || !Array.isArray(value.legacySettingsAdoptions)) throw new TypeError('Invalid component data adoption policy collections');
  const domainOwners = new Map();
  const globallyOwnedPaths = new Set();
  const legacyDomainDatabaseOwners = value.legacyDomainDatabaseOwners.map(entry => {
    exactKeys(entry, ['componentId', 'paths'], 'legacy domain database owner');
    const componentId = exactText(entry.componentId, IDENTIFIER, 'legacy domain database component id', 80);
    if (domainOwners.has(componentId) || !Array.isArray(entry.paths) || entry.paths.length < 1 || entry.paths.length > 16) throw new TypeError('Duplicate or invalid legacy domain database owner');
    const paths = entry.paths.map(databasePath);
    if (new Set(paths).size !== paths.length || paths.some(sourcePath => globallyOwnedPaths.has(sourcePath))) throw new TypeError('Legacy domain database path is claimed more than once');
    const owned = new Set(paths); paths.forEach(sourcePath => globallyOwnedPaths.add(sourcePath)); domainOwners.set(componentId, owned);
    return { componentId, paths };
  });
  const settingsOwners = new Map();
  const settingsComponents = new Set();
  const legacySettingsAdoptions = value.legacySettingsAdoptions.map(entry => {
    exactKeys(entry, ['componentId', 'topLevelKey'], 'legacy settings adoption owner');
    const componentId = exactText(entry.componentId, IDENTIFIER, 'legacy settings component id', 80);
    const topLevelKey = exactText(entry.topLevelKey, TOP_LEVEL_KEY, 'legacy settings top-level key', 128);
    if (RESERVED_TOP_LEVEL_CONFIG_KEYS.has(topLevelKey) || settingsOwners.has(topLevelKey) || settingsComponents.has(componentId)) throw new TypeError('Duplicate or reserved legacy settings adoption claim');
    settingsOwners.set(topLevelKey, componentId); settingsComponents.add(componentId);
    return { componentId, topLevelKey };
  });
  const policy = deepFreeze({ version: 1, legacyDomainDatabaseOwners, legacySettingsAdoptions });
  POLICY_INSTANCES.add(policy);
  return policy;
};

const defaultComponentDataAdoptionPolicy = createComponentDataAdoptionPolicy(rawDefaultPolicy);
const resolvePolicy = policy => {
  const resolved = policy || defaultComponentDataAdoptionPolicy;
  if (!POLICY_INSTANCES.has(resolved)) throw new TypeError('Unvalidated component data adoption policy');
  return resolved;
};
const ownsLegacyComponentDomainDatabase = (componentId, sourcePath, policy) => resolvePolicy(policy).legacyDomainDatabaseOwners.some(owner => owner.componentId === String(componentId || '') && owner.paths.includes(String(sourcePath || '')));
const isOwnedLegacyComponentDomainDatabase = (sourcePath, policy) => resolvePolicy(policy).legacyDomainDatabaseOwners.some(owner => owner.paths.includes(String(sourcePath || '')));
const legacyComponentOwnerForDomainDatabase = (sourcePath, policy) => resolvePolicy(policy).legacyDomainDatabaseOwners.find(owner => owner.paths.includes(String(sourcePath || '')))?.componentId || '';
const authorizesLegacySettingsAdoption = (componentId, topLevelKey, policy) => resolvePolicy(policy).legacySettingsAdoptions.some(owner => owner.componentId === String(componentId || '') && owner.topLevelKey === String(topLevelKey || ''));

module.exports = {
  createComponentDataAdoptionPolicy,
  defaultComponentDataAdoptionPolicy,
  ownsLegacyComponentDomainDatabase,
  isOwnedLegacyComponentDomainDatabase,
  legacyComponentOwnerForDomainDatabase,
  authorizesLegacySettingsAdoption,
};
