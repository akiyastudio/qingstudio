const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../src/features/workspace/batch-rename-preferences.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const load = () => {
  const loaded = { exports: {} };
  new Function('module', 'exports', compiled)(loaded, loaded.exports);
  return loaded.exports;
};
const { BATCH_RENAME_PREFERENCES_KEY: key, createBatchRenamePart, readBatchRenameParts, writeBatchRenameParts } = load();
const values = new Map();
const storage = {
  getItem: name => values.get(name) ?? null,
  setItem: (name, value) => values.set(name, value),
};
const rulesOnly = parts => parts.map(({ id, ...rule }) => rule);

assert.deepEqual(readBatchRenameParts(storage).map(part => part.type), ['text', 'sequence']);
const parts = [
  { ...createBatchRenamePart('datetime'), dateSource: 'created', dateFormat: 'DDMMYYYY' },
  { ...createBatchRenamePart('text'), value: '_sample_' },
  { ...createBatchRenamePart('sequence'), sequenceStart: 15, sequenceDigits: 4 },
  { ...createBatchRenamePart('original'), caseMode: 'lower' },
  { ...createBatchRenamePart('replace'), find: 'sample', replace: 'image' },
  { ...createBatchRenamePart('letter'), letterCase: 'lower' },
];
writeBatchRenameParts(parts, storage);
const restored = load().readBatchRenameParts(storage);
assert.deepEqual(rulesOnly(restored), rulesOnly(parts), 'a fresh module restores every rule in the saved order with its parameters');
assert.equal(new Set(restored.map(part => part.id)).size, parts.length);
assert(restored.every((part, index) => part.id !== parts[index].id), 'dialog row IDs are regenerated');
assert(!JSON.parse(storage.getItem(key)).some(part => 'id' in part), 'transient IDs are not preferences');

const edited = [parts[5], { ...parts[1], value: '-' }, parts[0]];
writeBatchRenameParts(edited, storage);
writeBatchRenameParts([], storage);
assert.deepEqual(rulesOnly(readBatchRenameParts(storage)), rulesOnly(edited), 'reordering, editing and removing rows are remembered; submission cleanup preserves them');

for (const invalid of ['{', 'null', '{}', '[]', '[null]', '[{"type":"unknown"}]']) {
  storage.setItem(key, invalid);
  assert.deepEqual(readBatchRenameParts(storage).map(part => part.type), ['text', 'sequence'], 'invalid preferences recover to defaults');
}
storage.setItem(key, JSON.stringify([{ type: 'sequence', sequenceStart: -1, sequenceDigits: 999, value: null, caseMode: 'unknown' }]));
const normalized = readBatchRenameParts(storage)[0];
assert.equal(normalized.sequenceStart, 1);
assert.equal(normalized.sequenceDigits, 2);
assert.equal(normalized.value, '');
assert.equal(normalized.caseMode, 'preserve');
const blockedStorage = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); } };
assert.deepEqual(readBatchRenameParts(blockedStorage).map(part => part.type), ['text', 'sequence']);
assert.doesNotThrow(() => writeBatchRenameParts(parts, blockedStorage));
assert.deepEqual(readBatchRenameParts().map(part => part.type), ['text', 'sequence'], 'missing browser storage is optional');
assert.doesNotThrow(() => writeBatchRenameParts(parts));
console.log('Batch rename preferences tests passed.');
