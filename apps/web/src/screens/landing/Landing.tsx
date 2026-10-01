import { AnswerGlyph } from '../../ui/AnswerGlyph.tsx';
import { ButtonLink } from '../../ui/Button.tsx';
import { PhoneShell } from '../../ui/PhoneShell.tsx';
import styles from './Landing.module.css';

export function Landing() {
  return (
    <PhoneShell>
      <div className={styles.hero}>
        <div className={styles.glyphs} aria-hidden="true">
          {[0, 1, 2, 3].map((slot) => (
            <AnswerGlyph key={slot} slot={slot} size={44} />
          ))}
        </div>
        <h1 className={styles.wordmark}>zqhoot</h1>
        <p className={styles.lead}>
          Live quizzes and polls for a room full of phones. Join with a PIN, or host your own game.
        </p>
      </div>
      <div className={styles.actions}>
        <ButtonLink to="/join" block>
          Join a game
        </ButtonLink>
        <ButtonLink to="/host" variant="secondary" block>
          Host a game
        </ButtonLink>
      </div>
    </PhoneShell>
  );
}
