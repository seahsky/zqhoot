# ADR-0006: Answer writes, live stats and reveal aggregation

Status: accepted (2026-09-29)

## Decision

### Writing answers

- One `ResponseRecord` per (session, question, player, slot). Single-response types use slot 0. Word cloud and open-ended use slots `0..maxEntries-1`: the service reads the player's existing responses for the question (one Query within the player's shard), takes the next free slot, and retries the next slot once if the conditional put loses a race.
- Conditional put with `attribute_not_exists(pk)` and `ReturnValuesOnConditionCheckFailure: ALL_OLD`: first write wins, and a retried message gets `answer.ack {status:'duplicate'}` with the original entry count. Single-response types therefore lock on first tap.
- The engine computes correctness, `elapsedMs` and base points at accept time. The streak bonus depends on earlier questions, so it is applied at reveal.
- Word-cloud entries are normalised (NFKC, trim, collapse whitespace, lowercase, max 25 chars). Entries that fail the profanity filter are stored with status `hidden`. Open-ended entries are stored `pending` when the question requires approval (default), `hidden` when the filter matches, else `visible`.
- No counter items and no writes to META or SCORES on the answer path.

### Live stats

Host clients (control and presenter) poll `host.stats` once per second while the question is open (`TIMING.statsPollMs`). The service reads the question's responses (4 consistent Queries) and the player count, and the engine aggregates them into `LiveStats`:

- choice/boolean counts,
- top 60 words,
- the rating histogram and average,
- open-ended responses after the host's cursor, 100 per page.

This replaces a push per answer: 400 answers become about 15 polls, and the presenter redraws at most once a second, which WCAG 2.2.2 prefers anyway. Hosts also use the count to send `host.close {reason:'all-answered'}` when every connected, non-kicked player has answered.

### Reveal

`host.close` (or the VM timer):

1. Engine transition: `question → revealing`, `closedAt = now`, META written with a version check.
2. Wait the adapter's settle interval (Lambda 1,000 ms, VM 0). An answer handler that passed its META check before the close commits its write within that window. One that reads META after the close is rejected as `too-late`, even if API Gateway received it slightly earlier; this edge case only arises on an early manual close.
3. Load responses, players and the scoreboard. The engine computes the `QuestionResult` (host view), each player's `PlayerOutcome` (points, streak bonus, new total, rank, streak), the new scoreboard (`appliedThrough = i`), and the outbound messages.
4. Write `RESULT#i`, SCORES (version-checked), then META `revealing → reveal`. If a step fails, META stays `revealing`. The next host command re-runs steps 3-4, and `appliedThrough` prevents double scoring.

Open-ended results are bounded so every message fits API Gateway's 128 KB limit (wave 1 gate finding G1):

- **Host result** (stored `RESULT#i` and `host.state`): the newest `LIMITS.openRevealMax` (100) `visible` responses plus the newest 50 `pending`/`hidden` ones, with the rest counted in `omitted`. `host.state` may drop further old responses to stay within a 120 KB budget. Hosts reach every response through `host.stats` paging.
- **Player `reveal`**: carries no open-ended responses (`responses: []`, `omitted` = number of visible responses). Phones never show other players' text. This also stops response IDs (which embed player IDs) from reaching players, where they could be matched to leaderboard nicknames (gate finding G5).
- **`StoredQuestionResult.visibleResponses`**: keeps the exact visible count once the list is capped.

## Consequences

- The answer path costs 2 GetItems + 1 PutItem + 1 `PostToConnection`, about 20-50 ms warm.
- On AWS, reveal adds about 1 s after close. The presenter fills it with a "Time's up" beat.
- Duplicate submissions cost a WCU each ([realtime-patterns](../research/realtime-patterns.md) 2). The per-connection limits in [ADR-0013](0013-security.md) cap that.
