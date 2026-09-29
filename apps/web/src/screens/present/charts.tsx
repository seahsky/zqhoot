import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { timerTier } from '../../state/format.ts';
import { groupDigits } from '../../state/charts.ts';
import type { BarRow } from '../../state/charts.ts';
import type { ChartData, ChartTable } from '../../state/presenterView.ts';
import { AnswerGlyph } from '../../ui/AnswerGlyph.tsx';
import { ResultIcon } from '../../ui/ResultIcon.tsx';
import { SLOTS } from '../../ui/slots.ts';
import { useStageUnitPx } from '../../ui/Stage.tsx';
import { StatusLine } from '../../ui/StatusLine.tsx';
import { VisuallyHidden } from '../../ui/VisuallyHidden.tsx';
import { useThrottled } from './hooks.ts';
import { CONTENT_WIDTH_U, cardsHeightU, cloudLayout, paginateCards } from './layout.ts';
import s from './Present.module.css';

const style = (vars: Record<string, string | number>) => vars as CSSProperties;

function TableAlternative({ table }: { table: ChartTable }) {
  return (
    <VisuallyHidden as="div">
      <table>
        <caption>{table.caption}</caption>
        <thead>
          <tr>
            {table.head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </VisuallyHidden>
  );
}

/**
 * Every chart is drawn for the eyes only and carries its meaning twice for everything else: a
 * hidden `<table>` with the numbers, and a `role="status"` sentence that changes at most once a
 * second however fast votes arrive (WCAG 1.1.1, 4.1.3, ADR-0016).
 */
export function ChartFrame({ chart, children }: { chart: ChartData; children: ReactNode }) {
  const summary = useThrottled(chart.summary, 1000);
  return (
    <div className={s.chart}>
      <div aria-hidden="true" className={s.chart}>
        {children}
      </div>
      <TableAlternative table={chart.table} />
      <StatusLine visible={false}>{summary}</StatusLine>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Bar({ row }: { row: BarRow }) {
  const token = SLOTS[row.slot]?.token ?? '--ink';
  return (
    <li className={`${s.barRow} ${row.correct ? s.correct : ''}`}>
      <div className={s.rowLabel}>
        <span className={s.rowGlyph}>
          <AnswerGlyph slot={row.slot} />
        </span>
        <span className={s.rowText}>
          {row.letter} · {row.label} · {groupDigits(row.count)} · {row.percent}%
        </span>
        {row.correct && (
          <span className={s.badge}>
            <ResultIcon kind="correct" size={24} />
            Correct
          </span>
        )}
      </div>
      <div className={s.track}>
        <div
          className={row.count > 0 ? s.fill : s.fillZero}
          style={style({ width: `${row.percent}%`, '--fill-color': `var(${token})` })}
        />
      </div>
    </li>
  );
}

/** Horizontal bars in answer order, zero baseline, direct labels: "A · text · 14 · 47%". */
export function BarChart({ chart }: { chart: Extract<ChartData, { kind: 'bars' }> }) {
  return (
    <ChartFrame chart={chart}>
      <ul className={`${s.bars} ${chart.rows.length > 4 ? s.barsDense : ''}`}>
        {chart.rows.map((row) => (
          <Bar key={row.slot} row={row} />
        ))}
      </ul>
    </ChartFrame>
  );
}

export function CloudChart({
  chart,
  heightU,
}: {
  chart: Extract<ChartData, { kind: 'cloud' }>;
  heightU: number;
}) {
  const layout = cloudLayout(chart.words, CONTENT_WIDTH_U, heightU);
  return (
    <ChartFrame chart={chart}>
      <ul className={s.cloud} style={{ maxHeight: `calc(var(--u) * ${heightU})` }}>
        {layout.words.map((w) => (
          <li key={w.text} className={s.word} style={style({ '--fs': w.drawnUnits.toFixed(2) })}>
            {w.text}
          </li>
        ))}
      </ul>
      {chart.words.length === 0 && <p className={s.lead}>Waiting for words…</p>}
    </ChartFrame>
  );
}

/**
 * Open-ended responses as cards, paged. The cards get the height that is left above the pager
 * (`cardsHeightU`), which on a small stage is more than the 5u its buttons take at full size.
 */
export function WallChart({
  chart,
  headU,
  page,
  onPage,
}: {
  chart: Extract<ChartData, { kind: 'wall' }>;
  /** Height of the prompt block above the cards, in u. */
  headU: number;
  page: number;
  onPage: (page: number) => void;
}) {
  const unitPx = useStageUnitPx();
  const wall = paginateCards(
    chart.responses.map((r) => r.text),
    CONTENT_WIDTH_U,
    cardsHeightU(headU, unitPx),
  );
  const pages = Math.max(1, wall.pages.length);
  const current = Math.min(Math.max(0, page), pages - 1);
  const shown = wall.pages[current] ?? [];
  return (
    <>
      <ChartFrame chart={chart}>
        <div className={s.cards}>
          {shown.map((column, c) => (
            <ul key={c} className={s.cardColumn}>
              {column.map((i) => (
                <li key={chart.responses[i]?.id} className={s.card}>
                  {chart.responses[i]?.text}
                </li>
              ))}
            </ul>
          ))}
        </div>
        {chart.responses.length === 0 && <p className={s.lead}>Waiting for responses…</p>}
      </ChartFrame>
      {pages > 1 && (
        <div className={s.pager}>
          <button
            type="button"
            className={s.pageButton}
            disabled={current === 0}
            onClick={() => onPage(current - 1)}
          >
            Previous page
          </button>
          <span className={s.meta}>
            Page {current + 1} of {pages}
          </span>
          <button
            type="button"
            className={s.pageButton}
            disabled={current >= pages - 1}
            onClick={() => onPage(current + 1)}
          >
            Next page
          </button>
        </div>
      )}
    </>
  );
}

export function RatingChart({ chart }: { chart: Extract<ChartData, { kind: 'rating' }> }) {
  const n = chart.bars.length;
  return (
    <ChartFrame chart={chart}>
      <div className={s.rating}>
        <p className={s.average}>
          {chart.average === null ? (
            'No ratings yet'
          ) : (
            <>
              Average {chart.average.toFixed(1)} of {chart.max}
            </>
          )}
        </p>
        <div className={s.hist} style={style({ '--n': n })}>
          {chart.bars.map((b) => (
            <div key={b.value} className={s.histCol}>
              <span className={s.histCount}>{groupDigits(b.count)}</span>
              <div
                className={`${s.histBar} ${b.count === 0 ? s.histZero : ''}`}
                style={{ height: `${b.height * 78}%` }}
              />
            </div>
          ))}
        </div>
        <div className={s.histAxis} style={style({ '--n': n })}>
          {chart.bars.map((b) => (
            <span key={b.value}>{b.value}</span>
          ))}
        </div>
        {(chart.minLabel || chart.maxLabel) && (
          <div className={s.histEnds}>
            <span>{chart.minLabel ? `1: ${chart.minLabel}` : ''}</span>
            <span>{chart.maxLabel ? `${chart.max}: ${chart.maxLabel}` : ''}</span>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------

/** The numeral, a shrinking bar (hidden under reduced motion) and a coarse spoken update. */
export function StageCountdown({
  secondsLeft,
  fraction,
  label,
  scale,
}: {
  secondsLeft: number | null;
  fraction: number | null;
  label?: string;
  /** Multiplier for the numeral, from the text-size control; the layout may hold it back. */
  scale?: number;
}) {
  const tier = secondsLeft === null || secondsLeft <= 0 ? null : timerTier(secondsLeft);
  const [spoken, setSpoken] = useState('');
  useEffect(() => {
    setSpoken(secondsLeft === null || secondsLeft <= 0 ? '' : `${secondsLeft} seconds left`);
    // Keyed on the tier: the sentence is read only when the tier changes, not every second.
  }, [tier]);

  if (secondsLeft === null) {
    return (
      <div className={s.timer}>
        <span className={s.timerLabel}>No time limit</span>
      </div>
    );
  }
  return (
    <div
      className={s.timer}
      style={scale === undefined ? undefined : style({ '--timer-scale': scale.toFixed(2) })}
    >
      {label && <span className={s.timerLabel}>{label}</span>}
      <span className={s.numeral} aria-hidden="true">
        {secondsLeft}
      </span>
      {fraction !== null && (
        <div className={s.bar} aria-hidden="true" data-testid="stage-countdown-bar">
          <div className={s.barFill} style={{ width: `${Math.round(fraction * 1000) / 10}%` }} />
        </div>
      )}
      <StatusLine visible={false}>{spoken}</StatusLine>
    </div>
  );
}
