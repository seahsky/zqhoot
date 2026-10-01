import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import styles from './StatusLine.module.css';

/**
 * A polite live region. It stays mounted even when empty, because screen readers only
 * announce changes to a region that existed before the change. Never rely on it alone:
 * anything essential is also visible text elsewhere.
 */
export function StatusLine({
  children,
  visible = true,
  className,
}: {
  children?: ReactNode;
  /** false keeps the announcement for assistive technology and hides it from view. */
  visible?: boolean;
  className?: string;
}) {
  return (
    <p role="status" className={cx(visible ? styles.status : styles.silent, className)}>
      {children}
    </p>
  );
}
