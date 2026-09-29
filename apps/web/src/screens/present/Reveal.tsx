import type { CSSProperties } from 'react';
import type { PresenterView } from '../../state/presenterView.ts';
import { BarChart, CloudChart, RatingChart, WallChart } from './charts.tsx';
import { Topline } from './Topline.tsx';
import { answeredText, eyebrowText } from './copy.ts';
import { CONTENT_WIDTH_U, chartRoomU, fitFontUnits, linesFor } from './layout.ts';
import s from './Present.module.css';

type RevealView = Extract<PresenterView, { screen: 'reveal' }>;

const style = (vars: Record<string, string | number>) => vars as CSSProperties;

/** The prompt stays on screen but gives way to the chart: 4.5u to 6u. */
function promptUnits(prompt: string, scale: number): number {
  return fitFontUnits({
    text: prompt,
    widthU: CONTENT_WIDTH_U,
    heightU: 16,
    maxU: 6 * scale,
    minU: 4.5,
    lineHeight: 1.15,
  });
}

/**
 * The result of a closed question: bars for single choice, true/false and poll (the correct
 * answer carries a "Correct" badge, a check icon and a thicker outline), a tag cloud, a wall of
 * approved responses, or a rating histogram with its average.
 */
export function RevealScreen({
  view,
  scale,
  wallPage,
  onWallPage,
}: {
  view: RevealView;
  scale: number;
  wallPage: number;
  onWallPage: (page: number) => void;
}) {
  const { q, chart } = view;
  const fs = promptUnits(q.prompt, scale);
  const headU = linesFor(q.prompt, fs, CONTENT_WIDTH_U) * fs * 1.15;

  return (
    <section className={s.screen} aria-labelledby="prompt">
      <Topline
        eyebrow={eyebrowText(q.index, q.total, true)}
        count={answeredText(view.answered, view.totalPlayers)}
      />
      <header>
        <h1 id="prompt" className={s.prompt} style={style({ '--fs': fs.toFixed(2) })}>
          {q.prompt}
        </h1>
      </header>
      {chart.kind === 'bars' && <BarChart chart={chart} />}
      {chart.kind === 'cloud' && <CloudChart chart={chart} heightU={chartRoomU(headU)} />}
      {chart.kind === 'wall' && (
        <WallChart chart={chart} headU={headU} page={wallPage} onPage={onWallPage} />
      )}
      {chart.kind === 'rating' && <RatingChart chart={chart} />}
    </section>
  );
}
