import { readFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MemoryStore,
  onMutation,
  serializeState,
  type MemoryStoreData,
  type MemoryStoreOptions,
} from './memory.ts';

export interface FilePersistence {
  /** Writes the current state now, after any write already in flight. */
  flush(): Promise<void>;
  /** Writes once more, then stops listening. Later calls are no-ops. */
  close(): Promise<void>;
}

export interface FilePersistenceOptions {
  /** Delay between the first unsaved mutation and the write. Default 1000. */
  debounceMs?: number;
  /** Receives failures of background writes; `flush` and `close` reject instead. */
  onError?: (error: unknown) => void;
}

/**
 * Keeps `path` in step with the store: after a mutation the state is written once `debounceMs`
 * has passed. The timer is not restarted by further mutations, so a busy session is still
 * saved every `debounceMs` (ADR-0015 promises at most about a second of staleness).
 * Writes are atomic: temp file, fsync, rename over the target.
 */
export function attachFilePersistence(
  store: MemoryStore,
  path: string,
  opts: FilePersistenceOptions = {},
): FilePersistence {
  const debounceMs = opts.debounceMs ?? 1000;
  const onError = opts.onError ?? ((e: unknown) => console.error('state persistence failed', e));
  let timer: NodeJS.Timeout | undefined;
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const write = (): Promise<void> => {
    // A failed write must not poison the queue, or one disk error would block every later write.
    const next = queue.then(() => writeAtomically(path, serializeState(store)));
    queue = next.catch(() => {});
    return next;
  };

  const detach = onMutation(store, () => {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      write().catch(onError);
    }, debounceMs);
  });

  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return {
    async flush() {
      if (closed) return;
      cancelTimer();
      await write();
    },
    async close() {
      if (closed) return;
      cancelTimer();
      detach();
      try {
        await write();
      } finally {
        closed = true;
      }
    },
  };
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // The state holds every quiz with its answers and every player's token hash: owner only.
  const handle = await open(tmp, 'w', 0o600);
  try {
    // `mode` only applies on creation; a stale tmp file could otherwise pass on wider permissions.
    await handle.chmod(0o600);
    await handle.writeFile(text, 'utf8');
    // Without the fsync a crash after the rename could leave a renamed but empty file.
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  await rename(tmp, path);
  await syncDirectory(dir);
}

/**
 * Makes the rename itself survive a power loss. Best effort: the data is already safe in the
 * renamed file, and not every platform or filesystem can fsync a directory.
 */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Ignored on purpose, see above.
  }
}

/**
 * Loads the state file written by `attachFilePersistence`. A missing file gives an empty store;
 * an unreadable or corrupt one throws rather than silently discarding the operator's data.
 * Synchronous because it runs once at startup.
 */
export function loadMemoryStore(path: string, opts: MemoryStoreOptions = {}): MemoryStore {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new MemoryStore(opts);
    throw error;
  }
  let data: MemoryStoreData;
  try {
    data = JSON.parse(text) as MemoryStoreData;
  } catch (error) {
    throw new Error(`state file ${path} is not valid JSON`, { cause: error });
  }
  return MemoryStore.fromJSON(data, opts);
}
