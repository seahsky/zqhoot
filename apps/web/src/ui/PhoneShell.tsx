import type { ReactNode } from 'react';
import styles from './PhoneShell.module.css';

export interface PhoneShellProps {
  /** Persistent strip above the screen, e.g. nickname and score. */
  header?: ReactNode;
  children: ReactNode;
}

/**
 * The phone layout frame: safe-area gutters, `100svh`, one centred column that stays
 * readable on a tablet or laptop. `main` is the focus target after route changes.
 */
export function PhoneShell({ header, children }: PhoneShellProps) {
  return (
    <div className={styles.shell}>
      <div className={styles.column}>
        {header && <header className={styles.header}>{header}</header>}
        <main id="main" tabIndex={-1} className={styles.main}>
          {children}
        </main>
      </div>
    </div>
  );
}
