# Build plan and status

Updated as tasks complete. Each task has a spec with acceptance criteria in `docs/tasks/`. Each task runs as: a Sonnet implementer in an isolated worktree branch, then a fresh Opus reviewer that verifies against the spec, then Sonnet fixes, looping until the review is clean (max 3 rounds). After that the lead reviews the diff, reruns the tests and squash-merges. Each phase ends with an independent Opus gate review.

## Phases

| Phase                  | Status      | Output                                                                                    |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| 1. Research            | done        | `docs/research/*.md`, `docs/research/SUMMARY.md`                                          |
| 2. Architecture        | done        | `docs/ARCHITECTURE.md`, `docs/adr/*`, `packages/protocol`, domain model, `Store` contract |
| 3-4. MVP build, wave 1 | in progress | engine, store, infra, web foundation                                                      |
| 3-4. MVP build, wave 2 | pending     | service, servers, host/presenter/editor UI, VM deploy                                     |
| 5. Verification        | pending     | E2E, load test, visual check, independent audit, README                                   |

## Tasks

| ID               | Spec                                          | Depends on                       | Status  |
| ---------------- | --------------------------------------------- | -------------------------------- | ------- |
| W1-engine        | [W1-engine](tasks/W1-engine.md)               | protocol                         | merged  |
| W1-store         | [W1-store](tasks/W1-store.md)                 | engine model                     | merged  |
| W1-infra         | [W1-infra](tasks/W1-infra.md)                 | none                             | running |
| W1-web-a         | [W1-web-a](tasks/W1-web-a.md)                 | protocol                         | running |
| W1-web-b         | [W1-web-b](tasks/W1-web-b.md)                 | W1-web-a                         | pending |
| W2-service       | [W2-service](tasks/W2-service.md)             | W1-engine, W1-store              | running |
| W2-server-node   | [W2-server-node](tasks/W2-server-node.md)     | W2-service                       | pending |
| W2-server-lambda | [W2-server-lambda](tasks/W2-server-lambda.md) | W2-service                       | pending |
| W2-vm-deploy     | [W2-vm-deploy](tasks/W2-vm-deploy.md)         | W2-server-node, W1-web-b         | pending |
| P5-e2e           | [P5-e2e](tasks/P5-e2e.md)                     | W2-server-node, W1-web-b         | pending |
| P5-load          | [P5-load](tasks/P5-load.md)                   | W2-server-node, W2-server-lambda | pending |
| P5-audit         | independent Opus audit of the whole repo      | all                              | pending |

```
protocol ─┬─ W1-engine ─┬─ W2-service ─┬─ W2-server-node ──┬─ W2-vm-deploy
          │  W1-store ──┘              └─ W2-server-lambda │
          ├─ W1-web-a ── W1-web-b ─────────────────────────┴─ P5-e2e, P5-load, P5-audit
W1-infra (independent; consumes the server-lambda build contract)
```

## Deferred review findings

| Task     | Finding                                                                                                                   | Why deferred                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| W1-store | R2-01: `deleteConnection` racing a `putConnection` that moves the same ID to another session can orphan a by-session item | Requires a connection ID reused across sessions at the same instant; the orphan expires with its 3 h TTL |
