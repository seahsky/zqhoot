import { useCallback, useEffect, useRef, useState } from 'react';
import { PROTOCOL_VERSION, PinLookupResponse, Pin } from '@zqhoot/protocol';
import type { JoinMsg, ServerMessage } from '@zqhoot/protocol';
import { navigate, useRoute } from '../../app/router.tsx';
import { getRuntimeConfig } from '../../config/runtime.ts';
import { Connection } from '../../net/connection.ts';
import { holdInMemory, saveCredentials } from '../../net/credentials.ts';
import { createHttpClient } from '../../net/http.ts';
import { toHref } from '../../app/routing.ts';
import { JoinNicknameScreen } from './JoinNicknameScreen.tsx';
import { JoinPinScreen } from './JoinPinScreen.tsx';
import {
  CONNECT_FAILED,
  joinErrorMessage,
  lookupErrorMessage,
  lookupRefusalMessage,
} from './copy.ts';
import { collapseWhitespace, digitsOnly, validateNickname } from './nickname.ts';

/** A join that has neither succeeded nor failed by now is treated as failed. */
const JOIN_TIMEOUT_MS = 15_000;

/** An error message plus a counter, so the same message twice still returns focus to the field. */
interface FieldError {
  message: string;
  seq: number;
}

export function JoinPage() {
  const route = useRoute();
  const [step, setStep] = useState<'pin' | 'nickname'>('pin');
  const [pin, setPin] = useState(() => digitsOnly(route.query.get('pin') ?? ''));
  const [lookup, setLookup] = useState<PinLookupResponse | null>(null);
  const [nickname, setNickname] = useState('');
  const [pinError, setPinError] = useState<FieldError | null>(null);
  const [nickError, setNickError] = useState<FieldError | null>(null);
  const [busy, setBusy] = useState(false);

  const pinRef = useRef<HTMLInputElement>(null);
  const nickRef = useRef<HTMLInputElement>(null);
  const connection = useRef<Connection | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const failPin = (message: string) => setPinError({ message, seq: (seq.current += 1) });
  const failNick = (message: string) => setNickError({ message, seq: (seq.current += 1) });

  const dropConnection = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    connection.current?.stop();
    connection.current = null;
  }, []);
  useEffect(() => dropConnection, [dropConnection]);

  // Focus follows the step, and returns to the field whenever an error is shown.
  useEffect(() => {
    if (step === 'pin') pinRef.current?.focus();
  }, [step, pinError]);
  useEffect(() => {
    if (step === 'nickname') nickRef.current?.focus();
  }, [step, nickError]);

  const submitPin = async () => {
    setPinError(null);
    if (!Pin.safeParse(pin).success) {
      failPin('The PIN is 6 digits, shown on the big screen.');
      return;
    }
    setBusy(true);
    try {
      const http = createHttpClient({ baseUrl: getRuntimeConfig().apiBaseUrl });
      const found = await http.get(`/api/join/${pin}`, { schema: PinLookupResponse });
      if (!found.joinable) {
        failPin(lookupRefusalMessage(found.reason));
        return;
      }
      setLookup(found);
      setStep('nickname');
    } catch (err) {
      failPin(lookupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const fail = (message: string, backToPin = false) => {
    dropConnection();
    setBusy(false);
    if (backToPin) {
      setStep('pin');
      failPin(message);
    } else {
      failNick(message);
    }
  };

  const onMessage = (msg: ServerMessage) => {
    if (msg.type === 'welcome' && msg.role === 'player') {
      if (!msg.credentials) return fail(CONNECT_FAILED);
      saveCredentials(msg.credentials);
      holdInMemory(msg.credentials);
      dropConnection();
      navigate(toHref('/play', { s: msg.credentials.sessionId }), { replace: true });
    } else if (msg.type === 'error') {
      const gone = msg.code === 'not-found' || msg.code === 'session-ended';
      fail(joinErrorMessage(msg.code, msg.message), gone);
    }
  };

  const submitNickname = () => {
    setNickError(null);
    const problem = validateNickname(nickname);
    if (problem) {
      failNick(problem);
      return;
    }
    const join: JoinMsg = {
      type: 'join',
      v: PROTOCOL_VERSION,
      pin,
      nickname: collapseWhitespace(nickname),
    };
    dropConnection();
    setBusy(true);
    // A fresh connection per attempt: `join` is sent once, on open, and a failed attempt
    // leaves nothing half-registered behind.
    const conn = new Connection({
      url: getRuntimeConfig().wsUrl,
      hello: () => join,
      onMessage,
      onStatus: (status) => {
        if (status === 'reconnecting') fail(CONNECT_FAILED);
      },
    });
    connection.current = conn;
    timeout.current = setTimeout(() => fail(CONNECT_FAILED), JOIN_TIMEOUT_MS);
    conn.start();
  };

  if (step === 'nickname' && lookup) {
    return (
      <JoinNicknameScreen
        quizTitle={lookup.quizTitle}
        nickname={nickname}
        onNicknameChange={setNickname}
        onSubmit={submitNickname}
        onBack={() => {
          setNickError(null);
          setStep('pin');
        }}
        error={nickError?.message}
        busy={busy}
        inputRef={nickRef}
      />
    );
  }
  return (
    <JoinPinScreen
      pin={pin}
      onPinChange={(v) => setPin(digitsOnly(v))}
      onSubmit={() => void submitPin()}
      error={pinError?.message}
      busy={busy}
      inputRef={pinRef}
    />
  );
}
