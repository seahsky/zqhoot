# ADR-0001: Repository layout and toolchain

Status: accepted (2026-09-29)

## Context

The brief fixes TypeScript, a pnpm monorepo, React + Vite, zod, Vitest, Playwright and a WebSocket load tool. It also requires the engine not to know its transport or store, and both servers to be thin adapters. Versions must be ones verified to exist.

## Decision

Layout as in the brief, plus one package:

- `packages/service`: the `GameService` that handles WebSocket events, plus a factory for the Hono HTTP app. It depends on `engine`, the `Store` interface and ports (`Transport`, `HostAuth`, `MediaStorage`, `Clock`, `Ids`, `Warmer`). Without it, the Lambda and Node servers would each re-implement "load state → call engine → persist → send", and the two targets would drift. With it, each server only translates its runtime's events into `GameService` calls and supplies port implementations. `GameService` is exercised end to end with `MemoryStore` and a fake transport, so most game behaviour is tested once, without I/O.

HTTP routes use Hono 4 because one app definition runs on both targets: `hono/aws-lambda` wraps it for API Gateway HTTP API events, and `@hono/node-server` wraps it for Node. Both adapters exist in the published packages (`npm view hono exports` lists `./aws-lambda`; `@hono/node-server` 2.1.1).

Internal packages export TypeScript source (`"exports": {".": "./src/index.ts"}`) and use `.ts` import specifiers. Vite, Vitest and esbuild compile them; `tsc` runs with `noEmit` for type checking only. No package has its own build step except the deployables (`apps/*`).

### Pinned toolchain (verified with `npm view` / binaries on 2026-09-29)

| Tool           | Version                                                      | Note                                                                                                                                |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Node.js        | 22 (dev), `nodejs24.x` on Lambda, `node:24-alpine` on the VM | nodejs22.x deprecates 2027-04-30, nodejs24.x 2028-04-30 (secondary source, research SUMMARY)                                        |
| pnpm           | 10.33.0                                                      | `packageManager` field                                                                                                              |
| TypeScript     | 7.0.2                                                        | Native compiler; verified to typecheck the base config                                                                              |
| zod            | 4.6.5                                                        | Refined objects inside discriminated unions verified to work                                                                        |
| Vitest         | 5.0.2                                                        |                                                                                                                                     |
| Vite           | 8.3.1, `@vitejs/plugin-react` 6.1.1                          |                                                                                                                                     |
| React          | 19.3.0                                                       |                                                                                                                                     |
| Playwright     | `@playwright/test` 1.56.1                                    | Matches the preinstalled Chromium build 1194; newer versions would need a browser download, which this environment's network blocks |
| esbuild        | 0.28.2                                                       | Lambda bundles                                                                                                                      |
| ws             | 8.22.0                                                       | Node WebSocket server                                                                                                               |
| hono           | 4.13.10, `@hono/node-server` 2.1.1                           |                                                                                                                                     |
| AWS SDK v3     | 3.1142.0                                                     | client-dynamodb, lib-dynamodb, client-apigatewaymanagementapi, client-s3, s3-presigned-post, client-lambda                          |
| aws-jwt-verify | 5.2.1                                                        | Cognito JWT verification                                                                                                            |
| jose           | 6.2.12                                                       | HS256 JWTs on the VM                                                                                                                |
| obscenity      | 0.4.6                                                        | Nickname and free-text filter                                                                                                       |
| nanoid         | 6.0.1                                                        | IDs                                                                                                                                 |
| qrcode         | 1.5.4                                                        | Join QR on the presenter                                                                                                            |
| k6             | 1.8.1                                                        | Built from source; see ADR-0014                                                                                                     |
| Terraform      | 1.16.4, AWS provider 6.66.0                                  | tflint 0.64.0 with AWS ruleset 0.49.0                                                                                               |

## Consequences

- Adding a runtime means writing an adapter and ports, not game logic.
- `packages/service` is the largest server-side package. It has no AWS or Node-specific imports, and a lint check (import boundary test) enforces that.
- TypeScript 7 is new. If a tool in the chain breaks with it, fall back to 6.0.3 (`npm view typescript@6 version`) with no code changes, since only type checking uses `tsc`.
