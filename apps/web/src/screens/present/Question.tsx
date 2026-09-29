import type { CSSProperties } from 'react';
import { groupDigits } from '../../state/charts.ts';
import type { ChartData, PresentQuestion, PresenterView } from '../../state/presenterView.ts';
import { AnswerGlyph } from '../../ui/AnswerGlyph.tsx';
import { SLOTS } from '../../ui/slots.ts';
import { BarChart, CloudChart, RatingChart, StageCountdown, WallChart } from './charts.tsx';
import { CONTENT_HEIGHT_U } from './layout.ts';
import { GAP_U, fitQuestion } from './questionFit.ts';
import type { OptionFit } from './questionFit.ts';
import s from './Present.module.css';

const style = (vars: Record<string, string | number>) => vars as CSSProperties;

type QuestionScreenView = Extract<PresenterView, { screen: 'get-ready' | 'question' | 'closing' }>;

function Options({ q, dim, fit }: { q: PresentQuestion; dim: boolean; fit: OptionFit }) {
  return (
    <ul
      className={`${s.options} ${fit.dense ? s.optionsDense : ''}`}
      style={style({ '--fs': fit.fs.toFixed(2) })}
      data-testid="options"
    >
      {q.options.map((o) => (
        <li key={o.slot} className={`${s.option} ${dim ? s.dim : ''}`} data-option>
          <span className={s.glyph}>
            <AnswerGlyph slot={o.slot} />
          </span>
          <span className={s.letter}>{SLOTS[o.slot]?.letter}</span>
          <span className={s.optionText}>{o.text}</span>
        </li>
      ))}
    </ul>
  );
}

function LiveChart({
  chart,
  heightU,
  wallPage,
  onWallPage,
}: {
  chart: ChartData;
  heightU: number;
  wallPage: number;
  onWallPage: (page: number) => void;
}) {
  switch (chart.kind) {
    case 'bars':
      return <BarChart chart={chart} />;
    case 'cloud':
      return <CloudChart chart={chart} heightU={heightU} />;
    case 'wall':
      return <WallChart chart={chart} heightU={heightU} page={wallPage} onPage={onWallPage} />;
    case 'rating':
      return <RatingChart chart={chart} />;
  }
}

/**
 * Get-ready, open and "Time's up": the same layout, so nothing jumps when the options open.
 * Options are neutral cards (ink outline, glyph, letter, text). While the question is open the
 * room sees only what the view model lets through: the answer count, and a live chart for
 * poll, word cloud, open-ended and rating (state/presenterView.ts).
 */
export function QuestionView({
  view,
  imageUrl,
  scale,
  wallPage,
  onWallPage,
}: {
  view: QuestionScreenView;
  imageUrl: string | null;
  scale: number;
  wallPage: number;
  onWallPage: (page: number) => void;
}) {
  const { q } = view;
  const { head, options, timerScale } = fitQuestion(q, scale, view.screen === 'get-ready');
  const live = view.screen === 'question' ? view.live : null;
  const showOptions = q.options.length > 0 && live === null;
  const chartHeightU = CONTENT_HEIGHT_U - head.heightU - GAP_U - 6;
  const count =
    view.screen === 'get-ready'
      ? null
      : `${groupDigits(view.answered)} / ${groupDigits(view.totalPlayers)} answered`;

  return (
    <section className={s.screen} aria-labelledby="prompt">
      <p className={s.eyebrow}>
        Question {q.index + 1} of {q.total}
      </p>
      {count && (
        <p className={s.countTop} data-testid="answer-count">
          {count}
        </p>
      )}
      <header className={s.head}>
        {view.screen === 'get-ready' && (
          <StageCountdown
            secondsLeft={view.secondsUntilOpen}
            fraction={null}
            label="Options open in"
            scale={timerScale}
          />
        )}
        {view.screen === 'question' && <StageCountdown {...view.countdown} scale={timerScale} />}
        {view.screen === 'closing' && (
          <div className={s.timer}>
            <span className={s.timeUp}>Time's up</span>
          </div>
        )}
        <h1 id="prompt" className={s.prompt} style={style({ '--fs': head.fs.toFixed(2) })}>
          {q.prompt}
        </h1>
      </header>

      {imageUrl && (
        <div className={s.image}>
          <img src={imageUrl} alt="Picture for this question" />
        </div>
      )}

      {live && (
        <LiveChart
          chart={live}
          heightU={chartHeightU}
          wallPage={wallPage}
          onWallPage={onWallPage}
        />
      )}
      {showOptions && <Options q={q} dim={view.screen === 'get-ready'} fit={options} />}
    </section>
  );
}
