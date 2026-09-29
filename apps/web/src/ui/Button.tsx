import type { ButtonHTMLAttributes } from 'react';
import { Link } from '../app/router.tsx';
import type { LinkProps } from '../app/router.tsx';
import { cx } from './cx.ts';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary';

function classes(variant: Variant, block: boolean, className?: string) {
  return cx(
    styles.button,
    variant === 'primary' ? styles.primary : styles.secondary,
    block && styles.block,
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Full width. */
  block?: boolean;
}

export function Button({
  variant = 'primary',
  block = false,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return <button {...rest} type={type} className={classes(variant, block, className)} />;
}

export interface ButtonLinkProps extends LinkProps {
  variant?: Variant;
  block?: boolean;
}

/** A navigation link that looks like a button. */
export function ButtonLink({
  variant = 'primary',
  block = false,
  className,
  ...rest
}: ButtonLinkProps) {
  return <Link {...rest} className={classes(variant, block, className)} />;
}
