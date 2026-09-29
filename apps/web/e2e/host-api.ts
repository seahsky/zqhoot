import type { Page, Route } from '@playwright/test';

/**
 * A tiny in-memory host API for the flow specs: quizzes and sessions the test can seed, every
 * request recorded with its method, path, bearer and body so specs can assert on what the
 * containers really sent.
 */

export const TOKEN = 'T'.repeat(40);

export interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
  accept: string | undefined;
  body: unknown;
}

export interface QuizRow {
  id: string;
  title: string;
  questionCount: number;
  updatedAt: number;
  version: number;
}

export interface SessionRow {
  sessionId: string;
  pin: string;
  quizId: string;
  quizTitle: string;
  phase: string;
  createdAt: number;
  expiresAt: number;
}

export class HostApi {
  readonly calls: Recorded[] = [];
  quizzes: QuizRow[] = [];
  sessions: SessionRow[] = [];
  /** Full quizzes by id, for GET and PUT. */
  readonly full = new Map<string, Record<string, unknown>>();
  /** Set to make the next PUT answer 409. */
  conflictOnce = false;
  csv = 'nickname,score\nAna,3120\n';
  private readonly gates: Record<'save' | 'upload', Promise<void> | null> = {
    save: null,
    upload: null,
  };

  /**
   * Keeps the reply to every request of this kind waiting until the returned function is called,
   * so a spec can do something in the middle of a save or an upload. The request is recorded
   * when it arrives, not when it is answered.
   */
  hold(kind: 'save' | 'upload'): () => void {
    let release: () => void = () => undefined;
    this.gates[kind] = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async attach(page: Page) {
    await page.route('**/api/me', (r) =>
      r.fulfill({ json: { hostId: 'local:admin', displayName: 'Alex Admin' } }),
    );
    await page.route('**/api/**', (route) => this.handle(route));
  }

  private record(route: Route, body: unknown): Recorded {
    const req = route.request();
    const rec: Recorded = {
      method: req.method(),
      path: new URL(req.url()).pathname,
      auth: req.headers().authorization,
      accept: req.headers().accept,
      body,
    };
    this.calls.push(rec);
    return rec;
  }

  calledWith(method: string, path: RegExp | string): Recorded[] {
    return this.calls.filter(
      (c) =>
        c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)),
    );
  }

  private async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/api/me') return route.fallback();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    const rec = this.record(route, body);
    const { method, path } = rec;

    if (path === '/api/quizzes' && method === 'GET') return route.fulfill({ json: this.quizzes });
    if (path === '/api/sessions' && method === 'GET') return route.fulfill({ json: this.sessions });
    if (path === '/api/sessions' && method === 'POST') {
      return route.fulfill({ json: { sessionId: 'session-demo-01', pin: '482915' } });
    }
    const results = /^\/api\/sessions\/([^/]+)\/results\.csv$/.exec(path);
    if (results && method === 'GET') {
      // Like the real server, the file starts with a UTF-8 byte order mark.
      const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(this.csv)]);
      return route.fulfill({ status: 200, contentType: 'text/csv', body });
    }
    if (path === '/api/quizzes' && method === 'POST') {
      await this.gates.save;
      const quiz = this.store('quiz-new-0001', 1, body as Record<string, unknown>);
      return route.fulfill({ status: 201, json: quiz });
    }
    const dup = /^\/api\/quizzes\/([^/]+)\/duplicate$/.exec(path);
    if (dup && method === 'POST') {
      const src = this.full.get(dup[1] as string);
      const quiz = this.store('quiz-copy-0001', 1, {
        ...(src ?? {}),
        title: `Copy of ${String(src?.title ?? '')}`,
      });
      return route.fulfill({ status: 201, json: quiz });
    }
    const one = /^\/api\/quizzes\/([^/]+)$/.exec(path);
    if (one) {
      const id = one[1] as string;
      if (method === 'GET') {
        const q = this.full.get(id);
        return q
          ? route.fulfill({ json: q })
          : route.fulfill({ status: 404, json: { error: 'not-found', message: 'No such quiz.' } });
      }
      if (method === 'DELETE') {
        this.quizzes = this.quizzes.filter((q) => q.id !== id);
        return route.fulfill({ status: 204 });
      }
      if (method === 'PUT') {
        await this.gates.save;
        if (this.conflictOnce) {
          this.conflictOnce = false;
          return route.fulfill({
            status: 409,
            json: { error: 'conflict', message: 'Version mismatch.' },
          });
        }
        const update = body as { expectedVersion: number; quiz: Record<string, unknown> };
        const held = this.full.get(id);
        const version = ((held?.version as number | undefined) ?? 0) + 1;
        return route.fulfill({ json: this.store(id, version, update.quiz) });
      }
    }
    if (path === '/api/media/uploads' && method === 'POST') {
      await this.gates.upload;
      return route.fulfill({
        json: {
          key: 'media/host-abc/uploaded01.png',
          expiresAt: Date.now() + 300_000,
          upload: {
            method: 'PUT',
            url: '/api/media/media/host-abc/uploaded01.png?token=t0k3n',
            headers: { 'Content-Type': 'image/png' },
          },
        },
      });
    }
    if (path.startsWith('/api/media/') && method === 'PUT') return route.fulfill({ status: 204 });
    return route.fulfill({
      status: 404,
      json: { error: 'not-found', message: `No route for ${method} ${path}` },
    });
  }

  private store(id: string, version: number, quiz: Record<string, unknown>) {
    const full = {
      ownerId: 'local:admin',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...quiz,
      id,
      version,
    };
    this.full.set(id, full);
    this.quizzes = [
      ...this.quizzes.filter((q) => q.id !== id),
      {
        id,
        title: String(quiz.title ?? ''),
        questionCount: Array.isArray(quiz.questions) ? quiz.questions.length : 0,
        updatedAt: Date.now(),
        version,
      },
    ];
    return full;
  }
}

/** A device that is already signed in: the token is in sessionStorage, as after `/host`. */
export async function signedIn(page: Page) {
  await page.addInitScript((token) => {
    if (!sessionStorage.getItem('zqhoot:host:auth')) {
      sessionStorage.setItem(
        'zqhoot:host:auth',
        JSON.stringify({ mode: 'local', token, expiresAt: Date.now() + 3_600_000 }),
      );
    }
  }, TOKEN);
}
