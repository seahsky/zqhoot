import { describe, expect, it } from 'vitest';
import { createWakeLock } from '../src/net/wakeLock.ts';
import { FakeDocument } from './helpers/fakes.ts';

class FakeSentinel {
  released = false;
  async release() {
    this.released = true;
  }
}

function setup(opts: { supported?: boolean; reject?: boolean } = {}) {
  const doc = new FakeDocument();
  const sentinels: FakeSentinel[] = [];
  let requests = 0;
  const nav =
    opts.supported === false
      ? {}
      : {
          wakeLock: {
            async request(_type: 'screen') {
              requests += 1;
              if (opts.reject) throw new DOMException('denied', 'NotAllowedError');
              const s = new FakeSentinel();
              sentinels.push(s);
              return s;
            },
          },
        };
  const lock = createWakeLock({
    navigator: nav,
    document: doc as unknown as Pick<
      Document,
      'visibilityState' | 'addEventListener' | 'removeEventListener'
    >,
  });
  return { lock, doc, sentinels, requests: () => requests };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('wake lock', () => {
  it('requests a screen lock on acquire, once', async () => {
    const t = setup();
    t.lock.acquire();
    t.lock.acquire();
    await flush();
    expect(t.requests()).toBe(1);
  });

  it('re-requests when the page becomes visible again, because hiding releases the lock', async () => {
    const t = setup();
    t.lock.acquire();
    await flush();
    t.sentinels[0]!.released = true; // the browser dropped it while hidden
    t.doc.visibilityState = 'hidden';
    t.doc.dispatch('visibilitychange');
    await flush();
    expect(t.requests()).toBe(1); // hidden: do not ask
    t.doc.visibilityState = 'visible';
    t.doc.dispatch('visibilitychange');
    await flush();
    expect(t.requests()).toBe(2);
  });

  it('does not stack requests while a lock is still held', async () => {
    const t = setup();
    t.lock.acquire();
    await flush();
    t.doc.dispatch('visibilitychange');
    await flush();
    expect(t.requests()).toBe(1);
  });

  it('releases on release() and stops listening', async () => {
    const t = setup();
    t.lock.acquire();
    await flush();
    t.lock.release();
    await flush();
    expect(t.sentinels[0]!.released).toBe(true);
    expect(t.doc.listenerCount('visibilitychange')).toBe(0);
    t.doc.dispatch('visibilitychange');
    await flush();
    expect(t.requests()).toBe(1);
  });

  it('releases a lock that arrives after release() was already called', async () => {
    const t = setup();
    t.lock.acquire();
    t.lock.release(); // before the request resolved
    await flush();
    expect(t.sentinels[0]?.released).toBe(true);
  });

  it('fails silently when unsupported or refused', async () => {
    const unsupported = setup({ supported: false });
    expect(() => unsupported.lock.acquire()).not.toThrow();
    const refused = setup({ reject: true });
    expect(() => refused.lock.acquire()).not.toThrow();
    await flush();
    expect(refused.requests()).toBe(1);
    expect(() => refused.lock.release()).not.toThrow();
  });

  it('works with no navigator or document at all', () => {
    const lock = createWakeLock({ navigator: null, document: null });
    expect(() => {
      lock.acquire();
      lock.release();
    }).not.toThrow();
  });
});
