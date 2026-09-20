import { Fragment, type ReactNode } from 'react';
import { useTranslation } from './react';
import type { MessageKey } from './runtime';

/** Translate the sentence as a unit; only explicitly supplied React nodes form rich content. */
export const LocalizedRichText = ({ messageKey, slots }: { messageKey: MessageKey; slots: Record<string, ReactNode> }) => {
  const t = useTranslation();
  const template = t(messageKey);
  const result: ReactNode[] = []; const occurrences = new Map<string, number>(); let offset = 0;
  for (const match of template.matchAll(/\{([A-Za-z][\w]*)\}/g)) {
    result.push(template.slice(offset, match.index));
    const slot = Object.prototype.hasOwnProperty.call(slots, match[1]) ? slots[match[1]] : match[0];
    const occurrence = occurrences.get(match[1]) ?? 0; occurrences.set(match[1], occurrence + 1);
    result.push(<Fragment key={match[1] + ':' + occurrence}>{slot}</Fragment>);
    offset = match.index! + match[0].length;
  }
  result.push(template.slice(offset));
  return <>{result}</>;
};
