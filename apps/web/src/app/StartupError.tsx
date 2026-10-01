import { Button } from '../ui/Button.tsx';
import { PhoneShell } from '../ui/PhoneShell.tsx';
import styles from './App.module.css';

/** Shown when `/config.json` cannot be loaded, before the router exists. */
export function StartupError() {
  return (
    <PhoneShell>
      <div className={styles.notice}>
        <h1>We can't reach the game server</h1>
        <p>Check your connection, then try again.</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </div>
    </PhoneShell>
  );
}
