# Final audit (phase 5)

An independent audit of the whole repository at commit `170b09c` against the brief, `docs/ARCHITECTURE.md` and the ADRs. Seven auditors each took one lens and could build, run and probe the code in throwaway worktrees. Every finding then went to adversarial verifiers, who tried to refute it: two for blocker or major, one for minor. A finding was kept when at least half of its verifiers could not refute it.

## What the auditors ran

- `pnpm typecheck`, `pnpm test` (2,941 tests in 9 projects; one conditional skip that needs a `dist/` build), `pnpm format:check`.
- `bash infra/terraform/validate.sh`: fmt, validate, 49 mock-provider tests, the always-on-resource guard and tflint all passed.
- `deploy/vm/smoke-test.sh`: passed (Docker image, Caddy, API, WebSocket, Origin refusal, restart persistence).
- `test:e2e:live` on the Node server (7 passed) and the Lambda emulator (7 passed), including five players to the podium.
- `test:e2e` gallery matrix: 756 passed.
- `load/run-local.sh node`: every gate met, in line with [load/RESULTS.md](../../load/RESULTS.md).
- The README local-dev commands, followed literally.

## Lens summaries

- **Brief:** all six hard requirements are met and every named deliverable is present. The README local-dev commands work as written. Three minor documentation findings.
- **Security:** these hold up:
  - answer secrecy before the reveal, and server-time scoring;
  - host authorisation on HTTP and WebSocket;
  - Cognito and local JWT verification, and scrypt login;
  - CSV formula neutralisation, and image upload checks;
  - headers and CSP on both targets, per-function IAM, and a non-root container.
    One major finding (the WebSocket `join` PIN oracle) and one minor (the non-atomic player cap).
- **Contracts:** every seam lines up:
  - protocol, engine, service and web;
  - the HTTP routes;
  - Lambda environment, build outputs, `config.json`, CSP origins and IAM actions;
  - Compose and SSM;
  - the deploy scripts and the k6 scripts.
    The exceptions are the close timing that drops the answer grace window, the auto-close count, and the Vite `/media` proxy.
- **Realtime:** the lifecycle holds on both stores: versioned META writes, reveal idempotency, moderation, resume at every phase, the ADR-0005 scoring edges, stale timers and PIN release. Four findings, each with a reproduced failure sequence.
- **Infra:**
  - The serverless stack scales to zero, its wiring matches the app, and the scripts are safe.
  - The ADR-0012 arithmetic checks out.
  - Two minor findings: UDP 443 closed on the VM, and ADR-0015 out of date. The buildx blocker was refuted (below).
- **Tests:** every suite passes on both targets, and the verification claims in the README and `load/RESULTS.md` are backed by the tests. One stale README.
- **Frontend:** these are sound: reconnect and resume, timer announcements, answer cues, reduced motion, the ADR-0016 layout rules, editor validation and conflicts, upload errors, and the presenter key map. Three major findings (sign-in loop on a forbidden session, unsaved changes lost on Back or Sign out, focus lost after host actions) and four minor.

## Findings kept

FA numbers are the order the workflow returned them in; the task specs quote each finding with its evidence and verifier notes.

| ID    | Severity | Lens      | Finding                                                                                                                                                                  | Routed to                                 |
| ----- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| FA-00 | minor    | brief     | Hot-reload dev mode (vite on :5173) breaks every uploaded-image preview: mediaBaseUrl points at Vite, which does not proxy /media                                        | lead, `fd18c59`                           |
| FA-01 | minor    | brief     | README's Cognito host-creation command omits --region and --desired-delivery-mediums EMAIL, unlike the Terraform README and the deploy script                            | lead, `fd18c59`                           |
| FA-02 | minor    | brief     | README local-dev says to open /join 'on a phone', but dev.env binds 127.0.0.1 and advertises localhost URLs                                                              | lead, `fd18c59`                           |
| FA-03 | major    | security  | WebSocket `join` lets anyone enumerate live game PINs, bypassing the per-IP failed-PIN limit                                                                             | [F1](../tasks/F1-realtime-audit-fixes.md) |
| FA-04 | minor    | security  | maxPlayers is checked then written non-atomically; concurrent joins overfill a session                                                                                   | F1                                        |
| FA-05 | major    | contracts | The host closes each question at the deadline, so answers inside the 750 ms grace window are rejected as too-late on both targets                                        | F1                                        |
| FA-06 | minor    | contracts | The "all-answered" auto-close compares against every non-kicked player, including players who left or are offline, against ADR-0006                                      | F1                                        |
| FA-07 | minor    | contracts | `vite dev` proxies /api, /config.json and /ws but not /media, so uploaded images do not display in the documented hot-reload setup                                       | lead, `fd18c59` (same as FA-00)           |
| FA-08 | major    | realtime  | Host clients close timed questions at the deadline, so answers in the 750 ms grace window (and slow or cold answer invocations) are rejected as too-late on both targets | F1 (same as FA-05)                        |
| FA-09 | minor    | realtime  | host.next from 'revealing' during the reveal settle runs the reveal immediately, dropping answers that were acknowledged as accepted                                     | F1                                        |
| FA-10 | minor    | realtime  | A timer host.close that is lost without an error frame is never retried, even after a reconnect; on Lambda the question stays at 'Time's up'                             | F1                                        |
| FA-11 | minor    | realtime  | A question broadcast that overtakes the resume welcome makes the player reducer drop the welcome, leaving me/quizTitle unset for that connection                         | F1                                        |
| FA-12 | minor    | infra     | README host-creation command leaves out --desired-delivery-mediums EMAIL, and the AWS default is SMS                                                                     | lead, `fd18c59` (same as FA-01)           |
| FA-13 | minor    | infra     | aws-vm security group does not open UDP 443, but Compose publishes 443/udp and Caddy advertises HTTP/3                                                                   | lead, `fd18c59`                           |
| FA-14 | minor    | infra     | ADR-0015 no longer matches the VM deployment that was built                                                                                                              | lead, `fd18c59`                           |
| FA-15 | minor    | tests     | Live e2e README still describes the Lambda CSV BOM bug as open and tracked with test.fail, but it has been fixed                                                         | lead, `fd18c59`                           |
| FA-16 | major    | frontend  | A 'forbidden' host.hello starts an unthrottled Cognito refresh and reconnect loop                                                                                        | [F2](../tasks/F2-web-audit-fixes.md)      |
| FA-17 | major    | frontend  | The editor's unsaved-changes warning is bypassed by browser Back/Forward and by Sign out                                                                                 | F2                                        |
| FA-18 | major    | frontend  | Keyboard focus drops to <body> after moderation Show/Hide and several host and editor actions                                                                            | F2                                        |
| FA-19 | minor    | frontend  | The presenter lobby's live region re-announces the PIN on every join                                                                                                     | F2                                        |
| FA-20 | minor    | frontend  | The ControlBar is marked role="toolbar", but → inside it advances the game                                                                                               | F2                                        |
| FA-21 | minor    | frontend  | 'Leave and lose changes' does nothing when 'New quiz' is clicked on an unsaved new quiz                                                                                  | F2                                        |
| FA-22 | minor    | frontend  | Question images cannot be given alt text; the presenter uses a generic alt                                                                                               | F2                                        |

## Finding refuted

- **infra, reported as blocker:** "VM bootstrap installs Docker without buildx, so the first `docker compose up -d --build` fails on the Dockerfile's `RUN --mount`". Refuted by both verifiers. The auditor reproduced the failure with Compose 5.1.1. One verifier extracted the Compose that Ubuntu 24.04 actually ships (2.40.3) and ran it with buildx hidden: it warns, then builds with BuildKit through its vendored buildx library. The lead added `docker-buildx` to the bootstrap and the Ubuntu install steps anyway (`fd18c59`), so a newer Compose does not break the build.

## Status

- Fixed by the lead in `fd18c59`: FA-00/07, FA-01/12, FA-02, FA-13, FA-14, FA-15.
- Fixed by [F1](../tasks/F1-realtime-audit-fixes.md) in `1d25268`: FA-03, FA-04, FA-05/08, FA-06, FA-09, FA-10, FA-11. Its reviewer raised one more case: a host who presses Next at "Time's up" could still cut the grace window. [F3](../tasks/F3-grace-followups.md) fixed that in `146ccd9`, and the ADRs were amended in `560e17a` and `aa09780`.
- Fixed by [F2](../tasks/F2-web-audit-fixes.md) in `62669d8`: FA-16 to FA-22.

All 20 distinct findings are fixed. Verified on the final code (`8d82c65`):

- Every package's unit and contract tests pass.
- The gallery suite passes 995 tests, with 8 intentional skips.
- The live five-player game passes on the Node server and on the Lambda emulator.
- The 400-player load test meets every gate on both targets ([load/RESULTS.md](../../load/RESULTS.md)).
