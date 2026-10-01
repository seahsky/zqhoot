import { useRoute } from '../../app/router.tsx';
import { DashboardPage } from './DashboardPage.tsx';
import { HostGate } from './HostGate.tsx';
import { LivePage } from './LivePage.tsx';

/** `/host` (sign-in and dashboard) and `/host/live?s=` (live control). */
export function HostPage() {
  const route = useRoute();
  return (
    <HostGate>
      {({ auth, displayName }) =>
        route.path === '/host/live' ? (
          <LivePage auth={auth} displayName={displayName} sessionId={route.query.get('s')} />
        ) : (
          <DashboardPage auth={auth} displayName={displayName} />
        )
      }
    </HostGate>
  );
}
