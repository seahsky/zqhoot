import type { ElementType, ReactNode } from 'react';
import styles from './VisuallyHidden.module.css';

/** Text for assistive technology only; still in the accessibility tree. */
export function VisuallyHidden({
  as: Tag = 'span',
  children,
}: {
  as?: ElementType;
  children: ReactNode;
}) {
  return <Tag className={styles.hidden}>{children}</Tag>;
}
