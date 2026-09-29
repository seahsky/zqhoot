import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { navigate } from '../app/router.tsx';
import { getRuntimeConfig } from '../config/runtime.ts';
import type { StorageLike } from '../net/credentials.ts';
import { createHostApi } from '../net/hostApi.ts';
import type { HostApi } from '../net/hostApi.ts';
import { HostAuth } from './session.ts';
import type { AuthSnapshot } from './session.ts';

let instance: HostAuth | null = null;

/** Reading `window.sessionStorage` itself throws when storage is blocked. */
function sessionStore(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** One controller per page load, so a StrictMode remount cannot spend a login code twice. */
export function getHostAuth(): HostAuth {
  if (!instance) {
    const config = getRuntimeConfig();
    instance = new HostAuth({
      auth: config.auth,
      apiBaseUrl: config.apiBaseUrl,
      origin: window.location.origin,
      storage: sessionStore(),
      redirect: (url) => window.location.assign(url),
    });
  }
  return instance;
}

export interface HostAuthState {
  auth: HostAuth;
  snapshot: AuthSnapshot;
}

/** Starts the controller (restore, or finish a Cognito redirect) and follows its state. */
export function useHostAuth(): HostAuthState {
  const auth = getHostAuth();
  const snapshot = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  useEffect(() => {
    void auth.start(window.location.search, (path) => navigate(path, { replace: true }));
  }, [auth]);
  return { auth, snapshot };
}

/** The host HTTP API, signed with the current token and retried once after a 401. */
export function useHostApi(auth: HostAuth): HostApi {
  return useMemo(
    () =>
      createHostApi({
        baseUrl: getRuntimeConfig().apiBaseUrl,
        getToken: auth.getToken,
        onUnauthorized: () => auth.handleUnauthorized(),
      }),
    [auth],
  );
}
