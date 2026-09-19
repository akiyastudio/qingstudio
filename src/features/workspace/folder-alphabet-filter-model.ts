export const FOLDER_ALPHABET_FILTER_THRESHOLD = 30;
export const FOLDER_ALPHABET_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const PINYIN_BOUNDARIES: ReadonlyArray<readonly [string, string]> = [
  ['A', '阿'], ['B', '八'], ['C', '擦'], ['D', '搭'], ['E', '蛾'], ['F', '发'],
  ['G', '噶'], ['H', '哈'], ['J', '击'], ['K', '喀'], ['L', '垃'], ['M', '妈'],
  ['N', '拿'], ['O', '哦'], ['P', '啪'], ['Q', '期'], ['R', '然'], ['S', '撒'],
  ['T', '塌'], ['W', '挖'], ['X', '昔'], ['Y', '压'], ['Z', '匝'],
];

const pinyinCollator = new Intl.Collator('zh-CN-u-co-pinyin', { sensitivity: 'base' });

export const folderAlphabetKey = (name: string) => {
  const first = name.trim().charAt(0);
  if (!first) return '#';
  const latin = first.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase();
  if (/^[A-Z]$/.test(latin)) return latin;
  if (!/\p{Script=Han}/u.test(first)) return '#';
  let key = '#';
  for (const [letter, boundary] of PINYIN_BOUNDARIES) {
    if (pinyinCollator.compare(first, boundary) < 0) break;
    key = letter;
  }
  return key;
};

export const availableFolderAlphabetKeys = (names: readonly string[]) => {
  const keys = new Set(names.map(folderAlphabetKey));
  return [...FOLDER_ALPHABET_KEYS, '#'].filter(key => keys.has(key));
};
