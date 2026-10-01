import type { ErrorCode, PinLookupResponse } from '@zqhoot/protocol';
import { ApiRequestError } from '../../net/http.ts';
import { nicknameReasonCopy } from './nickname.ts';

const NICKNAME_GENERIC = "That nickname isn't allowed. Try a different one.";

const JOIN_ERRORS: Partial<Record<ErrorCode, string>> = {
  'nickname-invalid': NICKNAME_GENERIC,
  'nickname-taken': 'Someone in this game already has that nickname. Try a different one.',
  'session-locked': "This game isn't letting new players in.",
  'session-full': 'This game is full.',
  'rate-limited': 'Too many tries. Wait a moment, then try again.',
  'not-found': "We couldn't find that game. It may have ended.",
  'session-ended': 'This game has ended.',
  'protocol-version': 'This page is out of date. Reload it, then try again.',
};

/**
 * For `nickname-invalid` the server's `message` names the reason (`too-long`, ...); an unknown
 * one, or an older server that sends prose, gets the generic sentence.
 */
export function joinErrorMessage(code: ErrorCode, serverMessage: string): string {
  if (code === 'nickname-invalid') {
    return nicknameReasonCopy(serverMessage.trim()) ?? NICKNAME_GENERIC;
  }
  return JOIN_ERRORS[code] ?? (serverMessage || 'Something went wrong. Try again.');
}

const LOOKUP_REFUSALS: Record<NonNullable<PinLookupResponse['reason']>, string> = {
  locked: "This game isn't letting new players in.",
  ended: 'This game has ended.',
  full: 'This game is full.',
};

export function lookupRefusalMessage(reason: PinLookupResponse['reason']): string {
  return reason ? LOOKUP_REFUSALS[reason] : "You can't join this game right now.";
}

export function lookupErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 404) return 'No game has that PIN. Check the number on the big screen.';
    if (err.status === 429) return 'Too many wrong PINs. Wait a minute, then try again.';
    if (err.error === 'network')
      return "Can't reach the game. Check your connection and try again.";
  }
  return 'Something went wrong. Try again.';
}

export const CONNECT_FAILED = "Couldn't connect. Check your connection and try again.";
