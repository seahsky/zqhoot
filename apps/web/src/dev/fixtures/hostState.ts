import type { HostSnapshot, LiveStats, ServerMessage } from '@zqhoot/protocol';
import { hostReducer, initialHostState } from '../../state/host.ts';
import type { HostState } from '../../state/host.ts';
import { NOW } from './common.ts';

/**
 * Host fixtures are built by feeding real protocol messages through the real reducer, like the
 * player ones, so a fixture cannot show a state the app cannot reach. Every message sent is
 * recorded here for test/gallery-fixtures.test.ts to validate against the schemas.
 */
export const HOST_FIXTURE_MESSAGES: ServerMessage[] = [];

export function feed(state: HostState, msg: ServerMessage): HostState {
  HOST_FIXTURE_MESSAGES.push(msg);
  return hostReducer(state, { type: 'message', msg });
}

/** A host connection that has just received its welcome snapshot, plus any further messages. */
export function hostStateOf(snapshot: HostSnapshot, ...more: ServerMessage[]): HostState {
  let state = feed(initialHostState('open'), {
    type: 'welcome',
    ts: NOW,
    role: 'host',
    snapshot,
  });
  for (const msg of more) state = feed(state, msg);
  return state;
}

export const statsFor = (stats: LiveStats, questionIndex = 2): ServerMessage => ({
  type: 'stats',
  ts: NOW,
  questionIndex,
  stats,
});
