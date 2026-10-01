import type {
  HostCloseMsg,
  HostEndMsg,
  HostKickMsg,
  HostLockMsg,
  HostModerateMsg,
  HostNextMsg,
  HostSkipMsg,
  HostSnapshot,
} from '@zqhoot/protocol';

/** Builders for the host commands, so every screen guards them the same way. */

export interface NextAction {
  /** What the big button says. */
  label: string;
  /** One line for people who cannot see the big screen, e.g. what pressing it does. */
  hint: string;
  /** Null when there is nothing left to advance to (the session has ended). */
  command: HostNextMsg | null;
}

/** A scored type with a points multiplier above 0, the engine's `isScoringQuestion`. */
function awardsPoints(snap: HostSnapshot): boolean {
  const q = snap.question?.question;
  return q !== undefined && (q.type === 'single' || q.type === 'truefalse') && q.points > 0;
}

export function isLastQuestion(snap: HostSnapshot): boolean {
  return snap.questionIndex >= snap.totalQuestions - 1;
}

/**
 * The step `host.next` takes from this phase (ARCHITECTURE: state machine). `from` names the
 * phase and question it was pressed in, so a second press or a second host window is a no-op.
 */
export function nextAction(snap: HostSnapshot): NextAction {
  const from = { phase: snap.phase, questionIndex: snap.questionIndex };
  const command: HostNextMsg = { type: 'host.next', from };
  const finishing = isLastQuestion(snap);
  switch (snap.phase) {
    case 'lobby':
      return { label: 'Start', hint: 'Show the first question.', command };
    case 'question':
      return { label: 'End question', hint: 'Stop taking answers and show the results.', command };
    case 'revealing':
      return { label: 'Show results', hint: 'The results are being worked out.', command };
    case 'reveal':
      if (awardsPoints(snap)) {
        return { label: 'Leaderboard', hint: 'Show the top players.', command };
      }
      return finishing
        ? { label: 'Finish', hint: 'End the game and show the final screen.', command }
        : { label: 'Next question', hint: 'Show the next question.', command };
    case 'leaderboard':
      return finishing
        ? { label: 'Finish', hint: 'End the game and show the final screen.', command }
        : { label: 'Next question', hint: 'Show the next question.', command };
    case 'ended':
      return { label: 'Finished', hint: 'This game has ended.', command: null };
  }
}

/** Enter on the projector: only while a question is open. */
export function closeCommand(
  snap: HostSnapshot,
  reason: HostCloseMsg['reason'] = 'manual',
): HostCloseMsg | null {
  return snap.phase === 'question'
    ? { type: 'host.close', questionIndex: snap.questionIndex, reason }
    : null;
}

export function skipCommand(snap: HostSnapshot): HostSkipMsg | null {
  return snap.phase === 'question'
    ? { type: 'host.skip', questionIndex: snap.questionIndex }
    : null;
}

export const endCommand = (): HostEndMsg => ({ type: 'host.end' });

export const lockCommand = (locked: boolean): HostLockMsg => ({ type: 'host.lock', locked });

export const kickCommand = (playerId: string): HostKickMsg => ({ type: 'host.kick', playerId });

export function moderateCommand(
  snap: HostSnapshot,
  responseId: string,
  status: HostModerateMsg['status'],
): HostModerateMsg | null {
  return snap.phase === 'question'
    ? { type: 'host.moderate', questionIndex: snap.questionIndex, responseId, status }
    : null;
}
