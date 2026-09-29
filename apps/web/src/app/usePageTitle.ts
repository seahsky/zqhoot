import { useEffect } from 'react';

/** WCAG 2.4.2: every page and screen has a title that says where you are. null leaves it alone. */
export function usePageTitle(title: string | null): void {
  useEffect(() => {
    if (title !== null) document.title = title;
  }, [title]);
}
