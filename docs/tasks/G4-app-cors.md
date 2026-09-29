# G4-app-cors: CORS in the app so the CSP can name the exact API endpoint

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Why

G3 moved AWS HTTP traffic off CloudFront and configured CORS on API Gateway (`cors_configuration`). The API resource therefore depends on the site URL, and the site's CSP cannot reference the API endpoint without a Terraform cycle. G3 used a Region-wide `https://*.execute-api.{region}.amazonaws.com` in `connect-src` instead. That lets an injected script talk to any API Gateway API in the Region, which weakens a stated control (ADR-0013).

The Lambda already receives the site origin (`ZQ_SITE_ORIGIN`) without a cycle. If the app answers CORS itself, the API resource no longer depends on the distribution, and the CSP can name the exact endpoint.

## Changes

1. **`packages/service/src/http-app.ts`**
   - Add an optional `cors?: { origins: string[] }` dependency.
   - When present, apply `hono/cors` (from `hono@4.13.10`; check its option names in `node_modules/hono/dist/types/middleware/cors/index.d.ts`) to `/api/*`:
     - `origin`: exact match against the list; any other origin gets no CORS headers
     - `allowMethods`: GET, POST, PUT, DELETE, OPTIONS
     - `allowHeaders`: `authorization`, `content-type`
     - `exposeHeaders`: `content-disposition`, `retry-after`, `x-request-id`
     - `maxAge`: 86400
     - `credentials`: false
   - When absent (the VM, which is same-origin), there is no CORS middleware.
   - Tests in `packages/service/test/http.test.ts`:
     - a preflight from an allowed origin gets 204 with the right headers
     - a disallowed origin gets no `Access-Control-Allow-Origin`
     - an actual GET from an allowed origin carries `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers`
     - without `cors` configured, no CORS headers appear
2. **`apps/server-lambda`**
   - The http handler passes `cors: { origins: [ZQ_SITE_ORIGIN] }`, plus any extra origins from an optional `ZQ_CORS_EXTRA_ORIGINS` (comma-separated, validated as `https://host` origins).
   - The emulator config uses the emulator's own web origin.
   - Update its README.
3. **`infra/terraform`**
   - Remove `cors_configuration` and the `allowed_origins` variable from `modules/http-api`. API Gateway must not also add CORS headers: with no `cors_configuration`, it passes the integration's headers through.
   - Make sure `OPTIONS` requests reach the Lambda: the `ANY /api/{proxy+}` route covers them; verify a route exists for every path the app serves.
   - `modules/static-site` takes the exact API origin (`https://{api_id}.execute-api.{region}.amazonaws.com`) for CSP `connect-src`.
   - Update `envs/aws-serverless` wiring and tests:
     - the CSP contains the exact API host and no `*`
     - the http-api module has no `cors_configuration`
     - `terraform validate` shows no cycle
   - Update the READMEs.
4. **Docs.** Update ADR-0013 (CORS handled by the app on AWS, the exact CSP origin) and ADR-0002, reverting their wildcard note.

## Files you own

- `packages/service/src/http-app.ts`, `packages/service/test/http.test.ts`, `packages/service/README.md`
- `apps/server-lambda/**` (only the CORS wiring, env parsing and its tests/README)
- `infra/terraform/**`
- `docs/adr/0002-realtime-transport.md`, `docs/adr/0013-security.md`

## Acceptance criteria

1. `pnpm --filter @zqhoot/service test`, `pnpm --filter @zqhoot/server-lambda test` and `bash infra/terraform/validate.sh` pass. Typechecks pass.
2. No `*` appears in CSP `connect-src` for the API. The CSP names the exact execute-api host, and there is no Terraform cycle.
3. The CORS behaviour is covered by tests on the service side, and the Lambda handler test shows a preflight works end to end through the Hono Lambda adapter with an API Gateway v2 OPTIONS event.
