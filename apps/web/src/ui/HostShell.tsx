import type { ReactNode } from 'react';
import { Link } from '../app/router.tsx';
import { Button } from './Button.tsx';
import styles from './HostShell.module.css';

export interface HostShellProps {
  /** Shown beside "Sign out". */
  displayName?: string | null;
  /** Omit on the sign-in page. */
  onSignOut?: () => void;
  /** Called before a header link navigates; return false to stay (unsaved changes). */
  onLeave?: (to: string) => boolean;
  children: ReactNode;
}

/**
 * Frame for the host's own pages (sign-in, dashboard, live control, editor): a header with the
 * wordmark and navigation, and a `main` that is the focus target after route changes. Sizes are
 * rem-based and the column reflows down to 320 px; on wide screens it is capped so lines stay
 * readable.
 */
export function HostShell({ displayName, onSignOut, onLeave, children }: HostShellProps) {
  const go = (to: string) => (e: { preventDefault: () => void }) => {
    if (onLeave && !onLeave(to)) e.preventDefault();
  };
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand} onClick={go('/')}>
          zqhoot
        </Link>
        {onSignOut && (
          <nav aria-label="Host" className={styles.nav}>
            <Link to="/host" className={styles.navLink} onClick={go('/host')}>
              Quizzes
            </Link>
            <Link to="/edit?q=new" className={styles.navLink} onClick={go('/edit?q=new')}>
              New quiz
            </Link>
          </nav>
        )}
        {onSignOut && (
          <div className={styles.user}>
            {displayName && <span className={styles.name}>{displayName}</span>}
            <Button variant="secondary" size="compact" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        )}
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        {children}
      </main>
    </div>
  );
}
