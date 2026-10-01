# Build plan and status

Updated as tasks complete. Each task has a spec with acceptance criteria in `docs/tasks/`. Each task runs as: a Sonnet implementer in an isolated worktree branch, then a fresh Opus reviewer that verifies against the spec, then Sonnet fixes, looping until the review is clean (max 3 rounds). After that the lead reviews the diff, reruns the tests and squash-merges. Each phase ends with an independent Opus gate review.

## Phases

| Phase                  | Status | Output                                                                                    |
| ---------------------- | ------ | ----------------------------------------------------------------------------------------- |
| 1. Research            | done   | `docs/research/*.md`, `docs/research/SUMMARY.md`                                          |
| 2. Architecture        | done   | `docs/ARCHITECTURE.md`, `docs/adr/*`, `packages/protocol`, domain model, `Store` contract |
| 3-4. MVP build, wave 1 | done   | engine, store, infra, web foundation, player screens                                      |
| 3-4. MVP build, wave 2 | done   | service, servers, host/presenter/editor UI, VM deploy                                     |
| 5. Verification        | done   | E2E, load test, visual check, final audit, and all their fixes (V1-V3, F1-F3) merged      |

## Tasks

| ID                      | Spec                                            | Depends on                       | Status |
| ----------------------- | ----------------------------------------------- | -------------------------------- | ------ |
| W1-engine               | [W1-engine](tasks/W1-engine.md)                 | protocol                         | merged |
| W1-store                | [W1-store](tasks/W1-store.md)                   | engine model                     | merged |
| W1-infra                | [W1-infra](tasks/W1-infra.md)                   | none                             | merged |
| W1-web-a                | [W1-web-a](tasks/W1-web-a.md)                   | protocol                         | merged |
| W1-web-b                | [W1-web-b](tasks/W1-web-b.md)                   | W1-web-a                         | merged |
| W2-service              | [W2-service](tasks/W2-service.md)               | W1-engine, W1-store              | merged |
| W2-ratelimit            | [W2-ratelimit](tasks/W2-ratelimit.md)           | W2-service                       | merged |
| W2-server-node          | [W2-server-node](tasks/W2-server-node.md)       | W2-service                       | merged |
| W2-server-lambda        | [W2-server-lambda](tasks/W2-server-lambda.md)   | W2-service                       | merged |
| W2-vm-deploy            | [W2-vm-deploy](tasks/W2-vm-deploy.md)           | W2-server-node, W1-web-b         | merged |
| G1-engine-fixes         | [G1-engine-fixes](tasks/G1-engine-fixes.md)     | wave 1 gate                      | merged |
| G2-web-fixes            | [G2-web-fixes](tasks/G2-web-fixes.md)           | W1-web-b, G1-engine-fixes        | merged |
| G3-aws-client-ip        | [G3-aws-client-ip](tasks/G3-aws-client-ip.md)   | wave 1 gate                      | merged |
| G4-app-cors             | [G4-app-cors](tasks/G4-app-cors.md)             | W2-server-lambda, G3             | merged |
| G5-nickname-bytes       | [G5-nickname-bytes](tasks/G5-nickname-bytes.md) | G1-engine-fixes                  | merged |
| P5-e2e                  | [P5-e2e](tasks/P5-e2e.md)                       | W2-server-node, W1-web-b         | merged |
| P5-load                 | [P5-load](tasks/P5-load.md)                     | W2-server-node, W2-server-lambda | merged |
| P5-audit                | [final audit](reviews/final-audit.md)           | all                              | done   |
| P5-visual               | [visual check](reviews/visual-check.md)         | P5-e2e                           | done   |
| V1-presenter-visual     | [V1](tasks/V1-presenter-visual.md)              | P5-visual                        | merged |
| V2-player-visual        | [V2](tasks/V2-player-visual.md)                 | P5-visual                        | merged |
| V3-host-editor-visual   | [V3](tasks/V3-host-editor-visual.md)            | P5-visual                        | merged |
| F1-realtime-audit-fixes | [F1](tasks/F1-realtime-audit-fixes.md)          | P5-audit                         | merged |
| F2-web-audit-fixes      | [F2](tasks/F2-web-audit-fixes.md)               | P5-audit, V1-V3                  | merged |
| F3-grace-followups      | [F3](tasks/F3-grace-followups.md)               | F1                               | merged |

```
protocol ─┬─ W1-engine ─┬─ W2-service ─┬─ W2-server-node ──┬─ W2-vm-deploy
          │  W1-store ──┘              └─ W2-server-lambda │
          ├─ W1-web-a ── W1-web-b ─────────────────────────┴─ P5-e2e, P5-load, P5-audit
W1-infra (independent; consumes the server-lambda build contract)
```

Review records: [wave 1 gate](reviews/wave1-gate.md), [visual check](reviews/visual-check.md), [final audit](reviews/final-audit.md).

## Deferred review findings

| Task              | Finding                                                                                                                   | Why deferred                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| W1-store          | R2-01: `deleteConnection` racing a `putConnection` that moves the same ID to another session can orphan a by-session item | Requires a connection ID reused across sessions at the same instant; the orphan expires with its 3 h TTL |
| G5-nickname-bytes | `maxPlayers` above 500 would push the host roster past 128 KB                                                             | No code path sets `maxPlayers` above `maxPlayersDefault` (500); clamp it if a setting is ever exposed    |
