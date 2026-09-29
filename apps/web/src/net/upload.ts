import { IMAGE_CONTENT_TYPES, LIMITS, UploadGrant, UploadRequest } from '@zqhoot/protocol';
import type { ImageContentType } from '@zqhoot/protocol';
import { ApiRequestError, joinUrl } from './http.ts';

/** Image uploads (ADR-0011): checks before asking for a grant, and the request a grant asks for. */

export interface FileInfo {
  type: string;
  size: number;
}

const MB = 1024 * 1024;

const isImageType = (type: string): type is ImageContentType =>
  (IMAGE_CONTENT_TYPES as readonly string[]).includes(type);

/** SVG is refused on purpose: it can carry script (ADR-0011). Null means the file may go up. */
export function checkImageFile(file: FileInfo): string | null {
  if (!isImageType(file.type)) {
    return 'Use a PNG, JPEG, WebP or GIF image. Other formats, including SVG, are not accepted.';
  }
  if (file.size < 1) return 'That file is empty.';
  if (file.size > LIMITS.imageMaxBytes) {
    return `That image is ${(file.size / MB).toFixed(1)} MB. The limit is ${LIMITS.imageMaxBytes / MB} MB.`;
  }
  return null;
}

/** The body of `POST /api/media/uploads`, validated with the protocol schema. */
export function uploadRequestFor(file: FileInfo): UploadRequest {
  return UploadRequest.parse({ contentType: file.type, size: file.size });
}

export interface PreparedUpload {
  url: string;
  init: RequestInit;
}

const isAbsolute = (url: string) => /^https?:\/\//i.test(url);

/**
 * The second request of an upload. A POST grant (S3) is a multipart form with every field the
 * grant lists first and the file last, because S3 ignores anything after the file and rejects a
 * form whose policy fields come late. A PUT grant (the VM) sends the bytes with the headers it
 * names. The VM's signed token is already in the URL, so no `Authorization` is added.
 */
export function prepareUpload(grant: UploadGrant, file: Blob, apiBaseUrl: string): PreparedUpload {
  const { upload } = grant;
  if (upload.method === 'POST') {
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append('file', file);
    return { url: upload.url, init: { method: 'POST', body: form } };
  }
  return {
    url: isAbsolute(upload.url) ? upload.url : joinUrl(apiBaseUrl, upload.url),
    init: { method: 'PUT', headers: { ...upload.headers }, body: file },
  };
}

/** `mediaBaseUrl` ends in a slash by convention, but do not depend on it. */
export function mediaUrl(mediaBaseUrl: string, key: string): string {
  return `${mediaBaseUrl.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

export interface UploadDeps {
  /** `HostApi.requestUpload`: the grant request, with the host API's 401 refresh and retry. */
  requestGrant: (request: UploadRequest) => Promise<UploadGrant>;
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
}

/** Asks for a grant, sends the file, and returns the key to store on the question. */
export async function uploadImage(file: File, deps: UploadDeps): Promise<string> {
  const problem = checkImageFile(file);
  if (problem) throw new ApiRequestError(0, 'invalid-file', problem);
  const grant = await deps.requestGrant(uploadRequestFor(file));
  const { url, init } = prepareUpload(grant, file, deps.apiBaseUrl);
  const doFetch = deps.fetchImpl ?? ((input, i) => fetch(input, i));
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch {
    throw new ApiRequestError(0, 'network', 'The image could not be sent. Check your connection.');
  }
  if (!res.ok) {
    throw new ApiRequestError(res.status, 'upload-failed', 'The server refused the image.');
  }
  return grant.key;
}
