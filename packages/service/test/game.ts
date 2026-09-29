import type { AnswerPayload, Phase, QuizInput } from '@zqhoot/protocol';
import type { Harness, HostKey } from './harness.ts';
import { miniQuiz } from './fixtures.ts';

export interface Joined {
  connectionId: string;
  playerId: string;
  token: string;
  sessionId: string;
}

/** A session with a connected host and, optionally, joined players, plus shorthands for the commands tests send. */
export interface Game {
  h: Harness;
  quizId: string;
  sessionId: string;
  pin: string;
  control: string;
  players: Record<string, Joined>;
  join(nickname: string): Promise<Joined>;
  next(phase: Phase, questionIndex: number): Promise<void>;
  close(questionIndex: number, reason?: 'manual' | 'timer' | 'all-answered'): Promise<void>;
  answer(
    nickname: string,
    questionIndex: number,
    payload: AnswerPayload,
    receivedAt: number,
  ): Promise<void>;
  /** Opens question `index` from the lobby or a previous reveal by pressing next. */
  open(from: {
    phase: Phase;
    questionIndex: number;
  }): Promise<{ openAt: number; deadline: number | null }>;
}

export async function startGame(
  h: Harness,
  opts: {
    quiz?: QuizInput;
    players?: string[];
    host?: HostKey;
    /** Prefix for connection names, to run two games in one harness. */
    label?: string;
  } = {},
): Promise<Game> {
  const quiz = await h.createQuiz(opts.quiz ?? miniQuiz(), opts.host);
  const { sessionId, pin } = await h.startSession(quiz.id, opts.host);
  const label = opts.label ?? '';
  const control = await h.hostHello(`${label}control`, sessionId, opts.host);
  const players: Record<string, Joined> = {};
  const game: Game = {
    h,
    quizId: quiz.id,
    sessionId,
    pin,
    control,
    players,
    async join(nickname) {
      const joined = await h.join(`${label}${nickname.toLowerCase()}`, pin, nickname);
      players[nickname] = joined;
      return joined;
    },
    next: (phase, questionIndex) =>
      h.send(control, { type: 'host.next', from: { phase, questionIndex } }),
    close: (questionIndex, reason = 'manual') =>
      h.send(control, { type: 'host.close', questionIndex, reason }),
    answer: (nickname, questionIndex, payload, receivedAt) =>
      h.send(
        players[nickname]!.connectionId,
        { type: 'answer', questionIndex, payload },
        receivedAt,
      ),
    async open(from) {
      await game.next(from.phase, from.questionIndex);
      const state = h.transport.last(control, 'host.state').snapshot;
      if (state.question === undefined)
        throw new Error(`no question after next from ${from.phase}`);
      return { openAt: state.question.openAt, deadline: state.question.deadline };
    },
  };
  for (const nickname of opts.players ?? []) await game.join(nickname);
  return game;
}

export const choice = (optionId: string): AnswerPayload => ({ kind: 'choice', optionId });
export const bool = (value: boolean): AnswerPayload => ({ kind: 'boolean', value });
export const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });
export const rating = (value: number): AnswerPayload => ({ kind: 'rating', value });
