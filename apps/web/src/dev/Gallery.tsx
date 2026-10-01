import { useEffect } from 'react';
import { Link, useRoute } from '../app/router.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import { RENDERERS } from './registry.tsx';
import { SCREENS } from './manifest.ts';
import type { ScreenId } from './manifest.ts';
import styles from './Gallery.module.css';

function hrefFor(id: string, theme: string | null): string {
  const query = new URLSearchParams({ screen: id });
  if (theme) query.set('theme', theme);
  return `/dev/gallery?${query.toString()}`;
}

function isScreenId(id: string): id is ScreenId {
  return Object.hasOwn(RENDERERS, id);
}

/** Pins the theme for a screen so light and dark can be captured deterministically. */
function useTheme(theme: string | null) {
  useEffect(() => {
    if (theme !== 'dark' && theme !== 'light') return;
    const root = document.documentElement;
    root.dataset.theme = theme;
    return () => {
      delete root.dataset.theme;
    };
  }, [theme]);
}

/**
 * `/dev/gallery` lists every screen; `/dev/gallery?screen=<id>` renders exactly one,
 * full page, and nothing else (Playwright screenshots and axe-scans that).
 * `&theme=dark|light` pins the stage theme.
 */
export default function Gallery() {
  const route = useRoute();
  const id = route.query.get('screen');
  const theme = route.query.get('theme');
  useTheme(theme);
  usePageTitle(id ? `Gallery: ${id}` : 'Screen gallery');

  if (id === null) {
    return (
      <main id="main" tabIndex={-1} className={styles.index}>
        <h1>Screen gallery</h1>
        <p>
          {SCREENS.length} screens rendered from fixtures. Add <code>&amp;theme=dark</code> to pin
          the dark stage.
        </p>
        <ul className={styles.list}>
          {SCREENS.map((s) => (
            <li key={s.id}>
              <Link to={hrefFor(s.id, theme)} data-screen-link={s.id}>
                {s.title}
              </Link>{' '}
              <code>{s.id}</code>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  if (!isScreenId(id)) {
    return (
      <main id="main" tabIndex={-1} className={styles.index}>
        <h1>Unknown screen</h1>
        <p>
          No screen has the id <code>{id}</code>. <Link to="/dev/gallery">Back to the list</Link>
        </p>
      </main>
    );
  }

  return <div data-gallery-screen={id}>{RENDERERS[id]()}</div>;
}
