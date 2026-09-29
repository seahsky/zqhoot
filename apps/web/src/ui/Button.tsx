import type { ButtonHTMLAttributes } from 'react';
import { Link } from '../app/router.tsx';
import type { LinkProps } from '../app/router.tsx';
import { cx } from './cx.ts';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary';
/** `compact` is for dense host screens on a desk; phones keep the full-size thumb targets. */
type Size = 'default' | 'compact';

function classes(variant: Variant, block: boolean, size: Size, className?: string) {
  return cx(
    styles.button,
    variant === 'primary' ? styles.primary : styles.secondary,
    block && styles.block,
    size === 'compact' && styles.compact,
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Full width. */
  block?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'default',
  block = false,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return <button {...rest} type={type} className={classes(variant, block, size, className)} />;
}

export interface ButtonLinkProps extends LinkProps {
  variant?: Variant;
  size?: Size;
  block?: boolean;
}

/** A navigation link that looks like a button. */
export function ButtonLink({
  variant = 'primary',
  size = 'default',
  block = false,
  className,
  ...rest
}: ButtonLinkProps) {
  return <Link {...rest} className={classes(variant, block, size, className)} />;
}
