import { useLocale } from './react';
import { renderText, type LocalizedText as TextValue } from './messages';
/** Application-owned messages only; user content must be rendered directly. */
export const LocalizedText = ({ value }: { value: TextValue | undefined }) => { useLocale(); return <>{renderText(value)}</>; };
