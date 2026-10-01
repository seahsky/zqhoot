import type { CSSProperties } from 'react';
import type { LiveStats, Question, QuestionResult } from '@zqhoot/protocol';
import { barRow, formatAverage, percentOf, ratingBars, sizeWords } from '../../state/charts.ts';
import type { BarRow } from '../../state/charts.ts';
import { AnswerGlyph } from '../../ui/AnswerGlyph.tsx';
import { cx } from '../../ui/cx.ts';
import { SLOTS } from '../../ui/slots.ts';
import styles from './Host.module.css';

/** A bar's length and, for an answer, its slot colour (ADR-0016: fills colour glyphs and bars). */
function fillStyle(percent: number, token?: string): CSSProperties {
  const style: Record<string, string> = { width: `${percent}%` };
  if (token) style['--fill-color'] = `var(${token})`;
  return style;
}

/**
 * What the host sees of the answers: a distribution while the question is open (hosts may see
 * it, the room may not) and the final figures after the close. Text carries every number; the
 * bars repeat them.
 */

function rowsFor(q: Question, data: LiveStats | QuestionResult | null): BarRow[] | null {
  const answered = data?.answered ?? 0;
  switch (q.type) {
    case 'single': {
      const counts = data?.type === 'single' ? data.counts : {};
      const correct = data && 'correctOptionId' in data ? data.correctOptionId : q.correctOptionId;
      return q.options.map((o, i) =>
        barRow(i, o.text, counts[o.id] ?? 0, answered, o.id === correct),
      );
    }
    case 'truefalse': {
      const counts = data?.type === 'truefalse' ? data.counts : { true: 0, false: 0 };
      return [
        barRow(0, 'True', counts.true, answered, q.correct),
        barRow(1, 'False', counts.false, answered, !q.correct),
      ];
    }
    case 'poll': {
      const counts = data?.type === 'poll' ? data.counts : {};
      return q.options.map((o, i) => barRow(i, o.text, counts[o.id] ?? 0, answered));
    }
    default:
      return null;
  }
}

function Bars({ rows, marksCorrect }: { rows: BarRow[]; marksCorrect: boolean }) {
  return (
    <ul className={styles.bars}>
      {rows.map((r) => (
        <li key={r.slot} className={styles.barRow}>
          <span className={styles.barLabel}>
            <AnswerGlyph slot={r.slot} size={22} />
            <span>
              {r.letter} · {r.label}
            </span>
            {marksCorrect && r.correct && <span className={styles.correctTag}>Correct answer</span>}
          </span>
          <span className={styles.barFigures}>
            {r.count} · {r.percent}%
          </span>
          <span className={styles.barTrack} aria-hidden="true">
            <span
              className={cx(styles.barFill, r.count === 0 && styles.barFillEmpty)}
              style={fillStyle(r.percent, SLOTS[r.slot]?.token)}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Distribution({
  question,
  stats,
  result,
}: {
  question: Question;
  /** Live figures while the question is open. */
  stats: LiveStats | null;
  /** Final figures once it has closed; wins over `stats`. */
  result: QuestionResult | null;
}) {
  const data = result ?? stats;
  const answered = data?.answered ?? 0;
  const total = data?.totalPlayers ?? 0;
  const rows = rowsFor(question, data);

  return (
    <div className={styles.dist}>
      <p className={styles.bigFigure}>
        <span className="tabular">{answered}</span> of <span className="tabular">{total}</span>{' '}
        answered ({percentOf(answered, total)}%)
      </p>
      {rows && <Bars rows={rows} marksCorrect={question.type !== 'poll'} />}
      {question.type === 'wordcloud' && (
        <WordList words={data?.type === 'wordcloud' ? data.words : []} />
      )}
      {question.type === 'rating' && data?.type === 'rating' && (
        <RatingList histogram={data.histogram} average={data.average} max={question.max} />
      )}
      {question.type === 'open' && data?.type === 'open' && result && (
        <p className={styles.meta}>
          {result.type === 'open' ? result.responses.length : 0} responses in total.
        </p>
      )}
    </div>
  );
}

function WordList({ words }: { words: ReadonlyArray<{ text: string; count: number }> }) {
  const sized = sizeWords(words);
  if (sized.length === 0) return <p className={styles.meta}>No words yet.</p>;
  return (
    <ul className={styles.wordList} aria-label="Words so far">
      {sized.slice(0, 30).map((w) => (
        <li key={w.text}>
          {w.text} <span className={styles.meta}>×{w.count}</span>
        </li>
      ))}
    </ul>
  );
}

function RatingList({
  histogram,
  average,
  max,
}: {
  histogram: readonly number[];
  average: number | null;
  max: number;
}) {
  const bars = ratingBars(histogram);
  return (
    <div>
      <p className={styles.bigFigure}>
        {average === null ? 'No ratings yet' : `Average ${formatAverage(average)} of ${max}`}
      </p>
      <ul className={styles.ratingList} aria-label="Ratings">
        {bars.map((b) => (
          <li key={b.value}>
            <span>{b.value}</span>
            <span className={styles.barTrack} aria-hidden="true">
              <span
                className={cx(styles.barFill, b.count === 0 && styles.barFillEmpty)}
                style={fillStyle(b.height * 100)}
              />
            </span>
            <span className="tabular">{b.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
