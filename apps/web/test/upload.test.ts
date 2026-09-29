import { describe, expect, it } from 'vitest';
import { LIMITS, UploadGrant } from '@zqhoot/protocol';
import { ApiRequestError } from '../src/net/http.ts';
import { createHostApi } from '../src/net/hostApi.ts';
import {
  checkImageFile,
  mediaUrl,
  prepareUpload,
  uploadImage,
  uploadRequestFor,
} from '../src/net/upload.ts';

const KEY = 'media/host-abc/abcdef123456.png';

const postGrant = (): UploadGrant =>
  UploadGrant.parse({
    key: KEY,
    expiresAt: 1_800_000_300_000,
    upload: {
      method: 'POST',
      url: 'https://media-bucket.example.test/',
      // Order matters to S3: policy fields before the file.
      fields: { key: KEY, 'Content-Type': 'image/png', policy: 'p', 'x-amz-signature': 's' },
    },
  });

const putGrant = (): UploadGrant =>
  UploadGrant.parse({
    key: KEY,
    expiresAt: 1_800_000_300_000,
    upload: {
      method: 'PUT',
      url: `/api/media/${KEY}?token=t0k3n`,
      headers: { 'Content-Type': 'image/png' },
    },
  });

const file = (type: string, size: number, name = 'a.png') =>
  new File([new Uint8Array(size)], name, { type });

describe('checking a file before asking for a grant', () => {
  it('accepts PNG, JPEG, WebP and GIF up to 5 MB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(checkImageFile({ type, size: 1024 }), type).toBeNull();
    }
    expect(checkImageFile({ type: 'image/png', size: LIMITS.imageMaxBytes })).toBeNull();
    expect(checkImageFile({ type: 'image/png', size: 1 })).toBeNull();
  });

  it('refuses anything else, SVG included, by name', () => {
    for (const type of ['image/svg+xml', 'image/bmp', 'application/pdf', 'text/html', '']) {
      expect(checkImageFile({ type, size: 1024 }), type).toMatch(/PNG, JPEG, WebP or GIF/);
    }
    expect(checkImageFile({ type: 'image/svg+xml', size: 10 })).toMatch(/SVG/);
  });

  it('refuses a file over 5 MB and an empty one, saying the sizes', () => {
    expect(checkImageFile({ type: 'image/png', size: LIMITS.imageMaxBytes + 1 })).toMatch(
      /limit is 5 MB/,
    );
    expect(checkImageFile({ type: 'image/png', size: 0 })).toMatch(/empty/);
  });

  it('the request body is what the protocol schema accepts', () => {
    expect(uploadRequestFor({ type: 'image/webp', size: 2048 })).toEqual({
      contentType: 'image/webp',
      size: 2048,
    });
    expect(() => uploadRequestFor({ type: 'image/svg+xml', size: 10 })).toThrow();
    expect(() => uploadRequestFor({ type: 'image/png', size: LIMITS.imageMaxBytes + 1 })).toThrow();
  });
});

describe('a POST grant (S3)', () => {
  it('is a multipart form: every field first, in order, then the file last', () => {
    const blob = file('image/png', 10);
    const { url, init } = prepareUpload(postGrant(), blob, '');
    expect(url).toBe('https://media-bucket.example.test/');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const entries = [...form.entries()];
    expect(entries.map(([name]) => name)).toEqual([
      'key',
      'Content-Type',
      'policy',
      'x-amz-signature',
      'file',
    ]);
    expect(entries.at(-1)?.[1]).toBeInstanceOf(File);
    expect(entries[0]?.[1]).toBe(KEY);
  });

  it('sets no headers of its own, so the browser writes the multipart boundary', () => {
    expect(prepareUpload(postGrant(), file('image/png', 1), '').init.headers).toBeUndefined();
  });
});

describe('a PUT grant (the VM)', () => {
  it('puts the bytes with the headers the grant names and no Authorization', () => {
    const blob = file('image/png', 10);
    const { url, init } = prepareUpload(putGrant(), blob, '');
    expect(url).toBe(`/api/media/${KEY}?token=t0k3n`);
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it('resolves a relative URL against the API base, and leaves an absolute one alone', () => {
    expect(prepareUpload(putGrant(), file('image/png', 1), 'https://api.example.test/v1').url).toBe(
      `https://api.example.test/v1/api/media/${KEY}?token=t0k3n`,
    );
    const absolute = UploadGrant.parse({
      ...putGrant(),
      upload: { method: 'PUT', url: 'https://cdn.example.test/put', headers: {} },
    });
    expect(prepareUpload(absolute, file('image/png', 1), 'https://api.example.test').url).toBe(
      'https://cdn.example.test/put',
    );
  });
});

describe('uploadImage end to end', () => {
  function server(grant: UploadGrant, uploadStatus = 204) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/api/media/uploads')) {
        return new Response(JSON.stringify(grant), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: uploadStatus });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  /** The host API as the editor builds it: the grant request goes through its `call()`. */
  const depsFor = (fetchImpl: typeof fetch, uploadFetch: typeof fetch = fetchImpl) => ({
    requestGrant: createHostApi({ baseUrl: '', getToken: () => 'jwt', fetchImpl }).requestUpload,
    apiBaseUrl: '',
    fetchImpl: uploadFetch,
  });

  it('asks for a grant with the type and size, uploads, and returns the key', async () => {
    const { calls, fetchImpl } = server(putGrant());
    const key = await uploadImage(file('image/png', 300), depsFor(fetchImpl));
    expect(key).toBe(KEY);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contentType: 'image/png',
      size: 300,
    });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    expect(calls[1]?.init.method).toBe('PUT');
  });

  it('never asks for a grant when the file is refused up front', async () => {
    const { calls, fetchImpl } = server(putGrant());
    await expect(uploadImage(file('image/svg+xml', 30), depsFor(fetchImpl))).rejects.toMatchObject({
      error: 'invalid-file',
    });
    await expect(
      uploadImage(file('image/png', LIMITS.imageMaxBytes + 1), depsFor(fetchImpl)),
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(calls).toHaveLength(0);
  });

  it('reports a refused upload and a network failure', async () => {
    const refused = server(postGrant(), 403);
    await expect(
      uploadImage(file('image/png', 5), depsFor(refused.fetchImpl)),
    ).rejects.toMatchObject({ status: 403, error: 'upload-failed' });

    const grantOnly = server(postGrant());
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/media/uploads')) return grantOnly.fetchImpl(input, init);
      throw new TypeError('offline');
    }) as typeof fetch;
    await expect(
      uploadImage(file('image/png', 5), depsFor(grantOnly.fetchImpl, failing)),
    ).rejects.toMatchObject({ status: 0, error: 'network' });
  });

  it('refreshes the sign-in and asks again when the grant request gets a 401', async () => {
    let token = 'expired';
    let refreshes = 0;
    const grant = putGrant();
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      seen.push({ url, auth });
      if (!url.endsWith('/api/media/uploads')) return new Response(null, { status: 204 });
      return auth === 'Bearer fresh'
        ? new Response(JSON.stringify(grant), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ error: 'unauthorized', message: 'expired' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
    }) as typeof fetch;
    const api = createHostApi({
      baseUrl: '',
      getToken: () => token,
      onUnauthorized: async () => {
        refreshes += 1;
        token = 'fresh';
        return true;
      },
      fetchImpl,
    });
    const key = await uploadImage(file('image/png', 300), {
      requestGrant: api.requestUpload,
      apiBaseUrl: '',
      fetchImpl,
    });
    expect(key).toBe(KEY);
    expect(refreshes).toBe(1);
    expect(seen.map((c) => c.auth)).toEqual(['Bearer expired', 'Bearer fresh', undefined]);
  });

  it('checks the request body with the protocol schema before it leaves', async () => {
    const { calls, fetchImpl } = server(putGrant());
    const api = createHostApi({ baseUrl: '', getToken: () => 'jwt', fetchImpl });
    await expect(
      api.requestUpload({ contentType: 'image/svg+xml', size: 10 } as never),
    ).rejects.toMatchObject({ error: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });
});

describe('the preview URL', () => {
  it('joins the media base and the key with exactly one slash', () => {
    expect(mediaUrl('https://example.test/', KEY)).toBe(`https://example.test/${KEY}`);
    expect(mediaUrl('https://example.test', KEY)).toBe(`https://example.test/${KEY}`);
    expect(mediaUrl('/', KEY)).toBe(`/${KEY}`);
  });
});
