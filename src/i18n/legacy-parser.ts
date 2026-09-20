/** Shared compatibility parser. Parameters remain data; no untrusted text is evaluated. */
export type LegacyParams = Record<string, string | number>;
export interface LegacyMessage { messageKey: string; params?: LegacyParams; parameterMessages?: Record<string, string> }
export const createLegacyParser = (catalogs: Record<string, Record<string, string>>, baseLanguage = 'zh-CN') => {
const legacyKeys = new Map<string, string>();
const legacyTemplates: Array<{ key: string; literals: string[]; names: string[] }> = [];
for (const catalog of Object.values(catalogs)) for (const [key, text] of Object.entries(catalog)) {
  if (!text.includes('{')) { if (!legacyKeys.has(text)) legacyKeys.set(text, key as string); continue; }
  const matches = [...text.matchAll(/\{([A-Za-z][\w]*)\}/g)];
  const literals: string[] = []; let offset = 0;
  for (const match of matches) { literals.push(text.slice(offset, match.index)); offset = match.index! + match[0].length; }
  literals.push(text.slice(offset));
  if (matches.length && literals.join('').length >= 4 && (literals[0].trim() || literals.at(-1)!.trim()) && literals.slice(1, -1).every(Boolean)) legacyTemplates.push({ key: (Object.prototype.hasOwnProperty.call(catalog, key.replace(/\.(zero|one|two|few|many|other)$/, '')) ? key.replace(/\.(zero|one|two|few|many|other)$/, '') : key) as string, literals, names: matches.map(match => match[1]) });
}
legacyTemplates.sort((a, b) => b.literals.join('').length - a.literals.join('').length);
/** Only for application-owned notices, after the legacy severity classifier has run. */
const parse = (source: string): LegacyMessage | undefined => {
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(source)) return undefined;
  const key = legacyKeys.get(source);
  if (key) return { messageKey: key };
  if (source.length > 8192) return undefined;
  // Linear delimiter matching: never compile untrusted text into regular expressions.
  for (const template of legacyTemplates) {
    if (!source.startsWith(template.literals[0]) || !source.endsWith(template.literals.at(-1)!)) continue;
    // Ambiguous delimiters can be part of a file/project name. Keep that text intact.
    const middle = template.literals.slice(1, -1);
    let ambiguous = false;
    for (const literal of new Set(middle)) {
      let occurrences = 0, cursor = 0;
      while ((cursor = source.indexOf(literal, cursor)) >= 0) { occurrences++; cursor += 1; }
      const expected = template.literals.reduce((count, part) => { let at = 0; while ((at = part.indexOf(literal, at)) >= 0) { count++; at += 1; } return count; }, 0);
      if (occurrences > expected) { ambiguous = true; break; }
    }
    if (ambiguous) continue;
    let offset = template.literals[0].length; let valid = true; const params: LegacyParams = {};
    for (let index = 0; index < template.names.length; index++) {
      const literal = template.literals[index + 1];
      const end = index === template.names.length - 1 ? source.length - literal.length : source.indexOf(literal, offset);
      if (end < offset) { valid = false; break; }
      const name = template.names[index]; const value = source.slice(offset, end);
      if (name === 'count' && (!/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))) { valid = false; break; }
      const parsed = name === 'count' ? Number(value) : value;
      if (Object.prototype.hasOwnProperty.call(params, name) && params[name] !== parsed) { valid = false; break; }
      params[name] = parsed; offset = end + literal.length;
    }
    if (valid && offset === source.length) {
      const base = catalogs[baseLanguage][template.key] ?? ''; const parameterMessages: Record<string, string> = {};
      for (const name of template.names) {
        const position = base.indexOf('{' + name + '}');
        const prefix = base.slice(base.lastIndexOf('}', position - 1) + 1, position);
        const value = params[name];
        // Only a known application error detail is translated; file/project names remain parameters.
        if (/失败|错误|异常/.test(prefix) && /[：:]\s*$/.test(prefix) && typeof value === 'string') {
          const detailKey = legacyKeys.get(value) ?? legacyKeys.get(value.replace(/^(?:Error|TypeError|RangeError):\s*/, '')); if (detailKey) parameterMessages[name] = detailKey;
        }
      }
      return { messageKey: template.key, params, ...(Object.keys(parameterMessages).length ? { parameterMessages } : {}) };
    }
  }
  return undefined;
};
  return parse;
};
