# ADR-0005: Timing, fairness and scoring

Status: accepted (2026-09-29)

## Context

- Scoring must use server time (brief).
- On Lambda, a 400-way broadcast spreads over roughly 0.2-0.8 s ([aws-realtime](../research/aws-realtime.md) E1). If the clock started at broadcast, the 400th recipient would lose up to 0.8 s.
- Client clocks and `performance.now()` can't be trusted: they can be forged or paused during sleep ([realtime-patterns](../research/realtime-patterns.md) 5).
- Kahoot's published formula is `round((1 - (t/T)/2) × P)` with full points under 0.5 s ([kahoot](../research/kahoot.md) 6, via search summary). We use our own curve.

## Decision

### Opening a question at the same instant for everyone

1. On `host.next`, the engine sets `openAt = now + lead`, where `lead = max(settings.readSeconds × 1000, minLead)`. `minLead` is 1,500 ms on Lambda and 750 ms on the VM (`TIMING.minLeadMs`). `deadline = openAt + timeLimitSec × 1000`, or null when untimed.
2. The question is broadcast at once. Phones show the prompt and a "get ready" countdown, with options inert.
3. Every server message carries `ts`, the server time stamped just before that recipient's send. The client keeps `offset = min(localReceiveTime - ts)` over the messages it has received since connecting. That minimum converges on the true offset plus the fastest observed downlink latency. The client therefore never believes the server clock is ahead of where it is, so it can open late but never early.
4. The client enables options at local time `openAt + offset` and runs its countdown to `deadline + offset`.

Fan-out position no longer matters as long as fan-out finishes within `lead`, which `minLead` is sized for. What remains unequal is each phone's own network latency: display lateness (downlink) plus answer uplink, typically tens of ms and occasionally a few hundred. This residual is accepted and documented, not compensated. RTT compensation is exploitable by delaying pongs.

### Accepting and timing answers

- `receivedAt` = API Gateway `requestContext.requestTimeEpoch` on AWS, or `Date.now()` when the Node server receives the frame. The Lambda's own clock is never used for `receivedAt`, since a cold start delays it.
- Accept only when phase is `question`, `questionIndex` matches, and `openAt - 250 ≤ receivedAt ≤ deadline + TIMING.answerGraceMs` (grace 750 ms, for uplink latency). Answers slightly before `openAt` are clamped to 0 elapsed, which absorbs clock-read differences between API Gateway and Lambda.
- `elapsedMs = clamp(receivedAt - openAt, 0, limitMs)`.

### Points

For scored types (`single`, `truefalse`) with multiplier `m` ∈ {0, 1, 2}:

```
if not correct or m == 0:  points = 0
elif untimed:              points = 1000·m
else:
  r = clamp((elapsedMs - 250) / (limitMs - 250), 0, 1)
  points = round(1000·m · (1 - 0.6·r))        # 1000 at best, 400 at the deadline
```

- Rounding is half away from zero (`Math.round` on positive values).
- **Streak:** consecutive correct answers on scored questions with `m > 0`. Wrong or missing answers reset it to 0. Unscored questions, skipped questions and `m == 0` questions leave it unchanged. The streak is always shown.
- **Streak bonus** (only if `settings.streakBonus`): `100·m · min(streak - 1, 3)` for `streak ≥ 2`, where `streak` includes the current answer. So +100/+200/+300, doubled on double-points questions. It is off by default: Kahoot removed its bonus because it widened gaps for weaker players ([kahoot](../research/kahoot.md) 6). We keep it as a host choice.
- **Ranking:** total score descending, competition ranking (1, 2, 2, 4). Ties are displayed in nickname order (locale-independent code-point comparison).
- Late joiners score 0 for questions they missed. Kicked players are excluded from ranks.

## Consequences

- Scores depend only on server-recorded times and stored answers, so a reveal can be recomputed deterministically.
- The 250 ms full-points window hides API Gateway/Lambda clock differences and the clamp's jitter.
- The residual network-latency unfairness of tens of ms is about 1-3 points per question on a 20 s timer (600 points spread over 19.75 s ≈ 30 points/s). This is documented in player-facing help.
- WCAG 2.2.1: untimed questions are supported for every type. The countdown has no flashing, and there's a numeric reduced-motion variant ([ADR-0016](0016-visual-identity.md)).
