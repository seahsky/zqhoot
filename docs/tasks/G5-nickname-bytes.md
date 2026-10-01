# G5-nickname-bytes: bound the roster's share of host messages

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Source: G1 review finding R1-01.

## Problem

`normalizeNickname` bounds nicknames by graphemes (2-16) and raw UTF-16 length (64). It does not bound UTF-8 bytes. An accepted Indic nickname such as `'क्ष्मी'.repeat(10) + 'किकि'` is 192 bytes.

With 500 such players, the roster alone in `host.state`/host `welcome` is about 130 KB, over API Gateway's 128 KB message limit. `PostToConnection` would then reject the host and presenter snapshots.

## Change

1. **Protocol.** Add `LIMITS.nicknameMaxBytes = 96`, measured in UTF-8 bytes of the normalised nickname. 96 bytes fits realistic names in every script: `'लक्ष्मी शर्मा'` is 37 bytes, and 16 flag emoji are 128 bytes (they must now be rejected as too long; that's acceptable). Document the reason next to the constant.
2. **Engine.**
   - `normalizeNickname` returns `too-long` when the normalised nickname exceeds `LIMITS.nicknameMaxBytes`, measured with `TextEncoder`. `TextEncoder` is a Web API available in Node and browsers; the engine purity test must still pass, so if it forbids globals other than the allowed ones, add `TextEncoder` to its allow-list with a comment.
   - Tests:
     - the 96-byte boundary (exactly 96 accepted, 97 rejected, using 3-byte characters and 4-byte emoji)
     - realistic names in Hindi, Bengali, Tamil, Thai, Arabic, Chinese and Vietnamese accepted
     - 16 flags rejected
3. **Size tests** (`packages/engine/test/size.test.ts`):
   - Use the byte-heaviest nickname the rules now accept (96 bytes) for all 500 players.
   - Assert the host `welcome` snapshot and `host.state` in **every phase** (lobby with the full roster, question, revealing, reveal with open-ended maximum content, leaderboard, ended) serialise to under 128 KB in UTF-8 bytes.
   - Fix the doc comments that call flags "the longest nickname".
4. **Web** (`apps/web`, join screen): only if the join nickname field shows a live counter, keep it grapheme-based. The server's `nickname-invalid` / `too-long` message is shown as is. Make no other web change: another task owns `apps/web`.
5. **Docs.** Update ADR-0009's nickname rules with the byte cap.

## Files you own

- `packages/protocol/src/limits.ts`, `packages/protocol/test/**`
- `packages/engine/**`
- `docs/adr/0009-auth-and-identity.md`

## Acceptance criteria

1. `pnpm --filter @zqhoot/protocol test` and `pnpm --filter @zqhoot/engine test` pass (coverage thresholds unchanged), and so does `pnpm --filter @zqhoot/service test` (DynamoDB Local at `http://localhost:8000`). Typechecks pass.
2. The size test proves every host snapshot phase is under 128 KB at 500 players with 96-byte nicknames.
3. `pnpm exec prettier --check packages docs` passes.
