import { z } from 'zod';
import { EpochMs, ErrorCode, Id, Phase, Pin } from './common.ts';
import { LIMITS, PROTOCOL_VERSION } from './limits.ts';
import {
  AnswerPayload,
  AnswerRejectReason,
  FinalStanding,
  HostSnapshot,
  LeaderboardEntry,
  LiveStats,
  OpenQuestionTiming,
  PlayerOutcome,
  PlayerSnapshot,
  PlayerStanding,
  PublicQuestion,
  QuestionResult,
  RosterEntry,
} from './play.ts';

const V = z.literal(PROTOCOL_VERSION);
const QIndex = z
  .number()
  .int()
  .min(0)
  .max(LIMITS.questionsMax - 1);

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** New player. Server replies `welcome` with credentials, or `error`. */
export const JoinMsg = z.object({
  type: z.literal('join'),
  v: V,
  pin: Pin,
  nickname: z.string().max(LIMITS.nicknameRawMaxLength),
});

/** Returning player on a new connection. */
export const ResumeMsg = z.object({
  type: z.literal('resume'),
  v: V,
  sessionId: Id,
  playerId: Id,
  token: z.string().min(20).max(128),
});

/** Host control or presenter screen. `authToken` is a Cognito or local JWT. */
export const HostHelloMsg = z.object({
  type: z.literal('host.hello'),
  v: V,
  sessionId: Id,
  client: z.enum(['control', 'present']),
  authToken: z.string().min(1).max(4096),
});

export const AnswerMsg = z.object({
  type: z.literal('answer'),
  questionIndex: QIndex,
  payload: AnswerPayload,
});

export const PingMsg = z.object({ type: z.literal('ping'), t: z.number() });

export const LeaveMsg = z.object({ type: z.literal('leave') });

/**
 * Advance: lobby -> question 0, reveal -> leaderboard (scored) or next question,
 * leaderboard -> next question or ended. `from` makes a repeated press a no-op.
 */
export const HostNextMsg = z.object({
  type: z.literal('host.next'),
  from: z.object({ phase: Phase, questionIndex: z.number().int().min(-1) }),
});

/** End answering now and reveal. Sent by hosts on timer expiry or when all have answered. */
export const HostCloseMsg = z.object({
  type: z.literal('host.close'),
  questionIndex: QIndex,
  reason: z.enum(['manual', 'timer', 'all-answered']),
});

/** Discard the current question (no results, no points) and move on. */
export const HostSkipMsg = z.object({ type: z.literal('host.skip'), questionIndex: QIndex });

export const HostEndMsg = z.object({ type: z.literal('host.end') });

export const HostKickMsg = z.object({ type: z.literal('host.kick'), playerId: Id });

export const HostLockMsg = z.object({ type: z.literal('host.lock'), locked: z.boolean() });

export const HostModerateMsg = z.object({
  type: z.literal('host.moderate'),
  questionIndex: QIndex,
  responseId: Id,
  status: z.enum(['visible', 'hidden']),
});

/** Poll live stats for the open question. `after` pages open-ended responses. */
export const HostStatsMsg = z.object({
  type: z.literal('host.stats'),
  questionIndex: QIndex,
  after: z.string().max(200).optional(),
});

export const ClientMessage = z.discriminatedUnion('type', [
  JoinMsg,
  ResumeMsg,
  HostHelloMsg,
  AnswerMsg,
  PingMsg,
  LeaveMsg,
  HostNextMsg,
  HostCloseMsg,
  HostSkipMsg,
  HostEndMsg,
  HostKickMsg,
  HostLockMsg,
  HostModerateMsg,
  HostStatsMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientMessageType = ClientMessage['type'];
export type HostCommand = Extract<ClientMessage, { type: `host.${string}` }>;

// ---------------------------------------------------------------------------
// Server -> client. Every message carries `ts`: server epoch ms stamped by the
// transport immediately before sending to that recipient (ADR-0005).
// ---------------------------------------------------------------------------

const ts = { ts: EpochMs };

export const WelcomeMsg = z.discriminatedUnion('role', [
  z.object({
    type: z.literal('welcome'),
    ...ts,
    role: z.literal('player'),
    /** Present only in reply to `join`; the client stores them for `resume`. */
    credentials: z.object({ sessionId: Id, playerId: Id, token: z.string() }).optional(),
    snapshot: PlayerSnapshot,
  }),
  z.object({
    type: z.literal('welcome'),
    ...ts,
    role: z.literal('host'),
    snapshot: HostSnapshot,
  }),
]);

export const ErrorMsg = z.object({
  type: z.literal('error'),
  ...ts,
  code: ErrorCode,
  message: z.string(),
  /** Type of the client message that caused the error, if known. */
  ref: z.string().optional(),
});

export const PongMsg = z.object({ type: z.literal('pong'), ...ts, t: z.number() });

/** Hosts: full state after every transition. */
export const HostStateMsg = z.object({
  type: z.literal('host.state'),
  ...ts,
  snapshot: HostSnapshot,
});

/** Hosts: players joined, left, disconnected or reconnected. */
export const RosterMsg = z.object({
  type: z.literal('roster'),
  ...ts,
  upsert: z.array(RosterEntry),
  removed: z.array(Id),
});

/** Hosts: reply to `host.stats`. */
export const StatsMsg = z.object({
  type: z.literal('stats'),
  ...ts,
  questionIndex: QIndex,
  stats: LiveStats,
});

/** Players: a question is shown; options become answerable at `openAt`. */
export const QuestionMsg = z.object({
  type: z.literal('question'),
  ...ts,
  sv: z.number().int(),
  index: QIndex,
  total: z.number().int(),
  question: PublicQuestion,
  ...OpenQuestionTiming.shape,
});

export const AnswerAckMsg = z.object({
  type: z.literal('answer.ack'),
  ...ts,
  index: QIndex,
  status: z.enum(['accepted', 'duplicate', 'rejected']),
  reason: AnswerRejectReason.optional(),
  /** Accepted entries so far for this question (word cloud / open-ended limits). */
  entries: z.number().int(),
});

export const RevealMsg = z.object({
  type: z.literal('reveal'),
  ...ts,
  sv: z.number().int(),
  index: QIndex,
  result: QuestionResult,
  you: PlayerOutcome,
});

export const LeaderboardMsg = z.object({
  type: z.literal('leaderboard'),
  ...ts,
  sv: z.number().int(),
  index: QIndex,
  entries: z.array(LeaderboardEntry),
  you: PlayerStanding,
});

export const EndedMsg = z.object({
  type: z.literal('ended'),
  ...ts,
  sv: z.number().int(),
  podium: z.array(LeaderboardEntry),
  totalPlayers: z.number().int(),
  you: FinalStanding,
});

/** Player removed by the host. The server closes the connection after sending. */
export const KickedMsg = z.object({ type: z.literal('kicked'), ...ts });

export const ServerMessage = z.union([
  WelcomeMsg,
  z.discriminatedUnion('type', [
    ErrorMsg,
    PongMsg,
    HostStateMsg,
    RosterMsg,
    StatsMsg,
    QuestionMsg,
    AnswerAckMsg,
    RevealMsg,
    LeaderboardMsg,
    EndedMsg,
    KickedMsg,
  ]),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerMessageType = ServerMessage['type'];

/** A server message before the transport stamps `ts`. */
export type OutboundMessage = ServerMessage extends infer M
  ? M extends { ts: number }
    ? Omit<M, 'ts'>
    : never
  : never;

// Inferred types for each message schema.
export type JoinMsg = z.infer<typeof JoinMsg>;
export type ResumeMsg = z.infer<typeof ResumeMsg>;
export type HostHelloMsg = z.infer<typeof HostHelloMsg>;
export type AnswerMsg = z.infer<typeof AnswerMsg>;
export type PingMsg = z.infer<typeof PingMsg>;
export type LeaveMsg = z.infer<typeof LeaveMsg>;
export type HostNextMsg = z.infer<typeof HostNextMsg>;
export type HostCloseMsg = z.infer<typeof HostCloseMsg>;
export type HostSkipMsg = z.infer<typeof HostSkipMsg>;
export type HostEndMsg = z.infer<typeof HostEndMsg>;
export type HostKickMsg = z.infer<typeof HostKickMsg>;
export type HostLockMsg = z.infer<typeof HostLockMsg>;
export type HostModerateMsg = z.infer<typeof HostModerateMsg>;
export type HostStatsMsg = z.infer<typeof HostStatsMsg>;
export type WelcomeMsg = z.infer<typeof WelcomeMsg>;
export type ErrorMsg = z.infer<typeof ErrorMsg>;
export type PongMsg = z.infer<typeof PongMsg>;
export type HostStateMsg = z.infer<typeof HostStateMsg>;
export type RosterMsg = z.infer<typeof RosterMsg>;
export type StatsMsg = z.infer<typeof StatsMsg>;
export type QuestionMsg = z.infer<typeof QuestionMsg>;
export type AnswerAckMsg = z.infer<typeof AnswerAckMsg>;
export type RevealMsg = z.infer<typeof RevealMsg>;
export type LeaderboardMsg = z.infer<typeof LeaderboardMsg>;
export type EndedMsg = z.infer<typeof EndedMsg>;
export type KickedMsg = z.infer<typeof KickedMsg>;
