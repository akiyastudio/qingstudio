const CORE_PROJECT_FOLDER_NAMES = Object.freeze([
  'raw',
  'jpg',
  'mov',
  'mov_转码',
  '图片选片',
  '视频选片',
  '策划',
]);

const normalizeName = name => String(name || '').trim().toLocaleLowerCase('zh-CN');

const createProtectedProjectFolderRegistry = ({ descriptors = [], descriptorProvider = null, descriptorRevisionProvider = null } = {}) => {
  let cachedRevision;
  let cachedNames;
  const policyNames = () => {
    const revision = descriptorRevisionProvider?.();
    if (descriptorRevisionProvider && cachedNames && revision === cachedRevision) return cachedNames;
    const protectedNames = new Set(CORE_PROJECT_FOLDER_NAMES.map(normalizeName));
    const progressRelocationNames = new Set(CORE_PROJECT_FOLDER_NAMES.map(normalizeName));
    const currentDescriptors = require('./rename-performance-diagnostics.cjs').measureRenameSync(
      'componentFolderPolicyDiscovery', () => descriptorProvider ? descriptorProvider() : descriptors,
    );
    for (const descriptor of currentDescriptors) {
      for (const policy of descriptor?.service?.projectFolders || []) {
        const name = normalizeName(policy.name);
        if (!name) continue;
        if (policy.protectFromGenericRename) protectedNames.add(name);
        if (policy.reserveProgressRelocationName) progressRelocationNames.add(name);
      }
    }
    const names = { protectedNames, progressRelocationNames };
    if (descriptorRevisionProvider) { cachedRevision = revision; cachedNames = names; }
    return names;
  };

  const isProtectedProjectFolderName = name => policyNames().protectedNames.has(normalizeName(name));
  const isProtectedProjectFolderPath = ({ fs, path, projectRoot, candidate }) => {
    const root = path.resolve(projectRoot);
    const target = path.resolve(candidate);
    if (physicalPathKey(path.dirname(target)) !== physicalPathKey(root)) return false;
    try {
      if (!fs.statSync(target).isDirectory()) return false;
    } catch {
      return false;
    }
    return isProtectedProjectFolderName(path.basename(target));
  };

  return Object.freeze({
    isProtectedProjectFolderName,
    isProtectedProjectFolderPath,
    progressRelocationReservedNames: () => Object.freeze([...policyNames().progressRelocationNames]),
  });
};

let activeRegistry = createProtectedProjectFolderRegistry();
const configureProtectedProjectFolderRegistry = options => {
  activeRegistry = createProtectedProjectFolderRegistry(options);
  return activeRegistry;
};
const getProtectedProjectFolderRegistry = () => activeRegistry;

module.exports = {
  CORE_PROJECT_FOLDER_NAMES,
  createProtectedProjectFolderRegistry,
  configureProtectedProjectFolderRegistry,
  getProtectedProjectFolderRegistry,
};
const { physicalPathKey } = require('./file-identity-service.cjs');
