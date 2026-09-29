import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { DraftRestore } from '../../state/player.ts';
import { Button } from '../../ui/Button.tsx';
import { TextArea, TextField } from '../../ui/TextField.tsx';
import styles from './TextEntry.module.css';

export interface TextEntryProps {
  kind: 'wordcloud' | 'open';
  /** Character limit per entry: 25 for a word cloud, 200 for open-ended. */
  maxLength: number;
  /** Entries this player can still send. */
  remaining: number;
  /** Entries already sent, oldest first. */
  entries: readonly string[];
  /**
   * Returns whether the entry was handed to the socket. The field is only cleared when it
   * was: an entry that could not be sent stays in the field for another try.
   */
  onSubmit: (text: string) => boolean;
  /** Text the server refused after it was sent; put back so the player need not retype it. */
  restore?: DraftRestore;
  disabled?: boolean;
}

/** Word cloud (one line, several entries) and open-ended (a textarea) share one form. */
export function TextEntry({
  kind,
  maxLength,
  remaining,
  entries,
  onSubmit,
  restore,
  disabled,
}: TextEntryProps) {
  // A refusal can arrive after this component was replaced (a one-entry open question shows
  // "answer locked in" meanwhile), so a restore present at mount seeds the field.
  const [value, setValue] = useState(restore?.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const restored = useRef(restore?.seq);

  useEffect(() => {
    if (!restore || restore.seq === restored.current) return;
    restored.current = restore.seq;
    // Never overwrite what the player has started typing since.
    setValue((current) => (current === '' ? restore.text : current));
  }, [restore]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text) {
      setError(kind === 'wordcloud' ? 'Type a word or phrase first.' : 'Write something first.');
      fieldRef.current?.focus();
      return;
    }
    setError(null);
    if (onSubmit(text)) setValue('');
    fieldRef.current?.focus();
  };

  // UTF-16 length, because that is what both `maxLength` and the protocol limit count.
  const counter = `${value.length} / ${maxLength}`;
  const isCloud = kind === 'wordcloud';
  const hint = isCloud
    ? `Up to ${maxLength} characters. You can send ${remaining} more.`
    : `Up to ${maxLength} characters.${remaining > 1 ? ` You can send ${remaining} more.` : ''}`;
  const common = {
    value,
    onChange: (e: { target: { value: string } }) => setValue(e.target.value),
    maxLength,
    disabled,
    hint,
    counter,
    error,
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {entries.length > 0 && (
        <ul className={styles.entries} aria-label="Your responses so far">
          {entries.map((text, i) => (
            <li key={i} className={styles.entry}>
              {text}
            </li>
          ))}
        </ul>
      )}
      {isCloud ? (
        <TextField
          {...common}
          label="Your word or short phrase"
          inputRef={fieldRef}
          autoComplete="off"
          autoCapitalize="off"
          enterKeyHint="send"
        />
      ) : (
        <TextArea
          {...common}
          label="Your response"
          inputRef={fieldRef}
          autoComplete="off"
          rows={4}
        />
      )}
      <Button type="submit" block disabled={disabled}>
        Send
      </Button>
    </form>
  );
}
