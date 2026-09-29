import { lazy, Suspense, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { JoinPage } from '../screens/join/JoinPage.tsx';
import { Landing } from '../screens/landing/Landing.tsx';
import { EditPage } from '../screens/edit/EditPage.tsx';
import { HostPage } from '../screens/host/HostPage.tsx';
import { PlayPage } from '../screens/play/PlayPage.tsx';
import { PresentPage } from '../screens/present/PresentPage.tsx';
import { ButtonLink } from '../ui/Button.tsx';
import { PhoneShell } from '../ui/PhoneShell.tsx';
import styles from './App.module.css';
import { loadGallery } from './gallery.ts';
import { matchPath, useRoute } from './router.tsx';
import { usePageTitle } from './usePageTitle.ts';

function NotFound() {
  return (
    <PhoneShell>
      <div className={styles.notice}>
        <h1>Page not found</h1>
        <p>There's nothing at this address.</p>
        <ButtonLink to="/">Back to start</ButtonLink>
      </div>
    </PhoneShell>
  );
}

interface RouteDef {
  /** `/host*` matches the prefix and everything under it. */
  pattern: string;
  /** null lets the page set its own title. */
  title: string | null;
  render: () => ReactNode;
}

const Gallery = loadGallery ? lazy(loadGallery) : null;

/**
 * The route table; first match wins. The host, presenter and editor pages set their own titles
 * and sit behind the sign-in gate.
 */
const ROUTES: RouteDef[] = [
  { pattern: '/', title: 'zqhoot', render: () => <Landing /> },
  { pattern: '/join', title: 'Join a game · zqhoot', render: () => <JoinPage /> },
  { pattern: '/play', title: null, render: () => <PlayPage /> },
  { pattern: '/host*', title: null, render: () => <HostPage /> },
  { pattern: '/present', title: null, render: () => <PresentPage /> },
  { pattern: '/edit*', title: null, render: () => <EditPage /> },
];

if (Gallery) {
  ROUTES.unshift({
    pattern: '/dev/gallery',
    title: null,
    render: () => (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    ),
  });
}

export function App() {
  const route = useRoute();
  const match = ROUTES.find((r) => matchPath(r.pattern, route.path));
  usePageTitle(match ? match.title : 'Page not found · zqhoot');

  // After a client-side navigation the clicked link is gone; put focus at the page's `main`
  // unless a page already focused something (the join form focuses its field).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || !document.contains(active)) {
      document.getElementById('main')?.focus({ preventScroll: true });
    }
  }, [route.path]);

  return <>{match ? match.render() : <NotFound />}</>;
}
