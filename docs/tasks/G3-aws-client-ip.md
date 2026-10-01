# G3-aws-client-ip: rate-limit on the real client IP on AWS

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Source: wave 1 gate finding G6 (`docs/reviews/wave1-gate.md`).

## Problem

On the AWS target the HTTP API sits behind CloudFront (`/api/*` behaviour). The Lambda sees `requestContext.http.sourceIp` = a CloudFront edge address, not the player's IP. So the per-IP limits (30 failed PIN lookups/min, 10 logins per 15 min) are shared across everyone behind the same edge IPs. A typo-prone class can lock itself out, and an attacker is limited per edge rather than per client.

Forwarding a viewer-IP header through CloudFront would also need a custom origin request policy that still excludes `Host`, keeps `Authorization`, and trusts the header only for traffic that really came through CloudFront. We cannot verify those CloudFront behaviours without an AWS account.

## Decision (lead)

The browser calls the HTTP API **directly** at its `execute-api` endpoint, cross-origin with CORS, instead of through CloudFront. API Gateway then reports the real client address as `sourceIp`. Static files and `/media/*` stay on CloudFront. WebSockets are already direct.

## Required changes

1. **`infra/terraform/modules/http-api`**
   - Add `cors_configuration` to the HTTP API:
     - `allow_origins` = the site origin(s) (a variable, no wildcard)
     - `allow_methods` = GET, POST, PUT, DELETE, OPTIONS
     - `allow_headers` = `authorization`, `content-type`
     - `expose_headers` = `content-disposition`
     - `max_age` = 86400
     - `allow_credentials` = false (bearer tokens, no cookies)
   - Add `OPTIONS` handling only if the API Gateway CORS configuration doesn't already cover preflight. It does for HTTP APIs with `cors_configuration`; confirm against the provider's documented argument names in the local provider schema (`terraform providers schema -json`), and don't guess.
   - Keep throttling.
2. **`infra/terraform/modules/static-site`**
   - Remove the `/api/*` ordered cache behaviour and the HTTP API origin.
   - Add the API endpoint to CSP `connect-src`.
   - Update module variables/outputs accordingly.
3. **`infra/terraform/envs/aws-serverless`**
   - `config.json`: `apiBaseUrl` = the HTTP API invoke URL (no trailing slash; the web client appends `/api/...`).
   - Wire the allowed origin (the site URL, or custom domain URLs) into the http-api module.
   - Update the env test that asserts `config.json` and the CSP.
4. **Docs**
   - Amend `docs/adr/0002-realtime-transport.md` (HTTP no longer through CloudFront; reason: accurate client IP for rate limiting, no dependence on unverifiable header forwarding) and `docs/adr/0013-security.md` (CORS allowlist, CSP `connect-src`).
   - Update `infra/terraform/README.md` and module READMEs.
   - Add a line to `docs/ARCHITECTURE.md`'s overview diagram and key-decisions table.
5. **Web client**
   - Check that `apps/web/src/net/http.ts` builds URLs from `RuntimeConfig.apiBaseUrl` for every call, including the CSV download and media upload grant, and sends no cookies (`credentials: 'omit'`).
   - Only if a change is needed, make it minimal and report it: `apps/web` is being edited by another task.
6. **Tests**
   - Terraform mock tests assert:
     - the CORS configuration (exact origins, no `*`)
     - the static-site no longer has an `/api/*` behaviour
     - `config.json.apiBaseUrl` equals the API endpoint
   - `infra/terraform/validate.sh` passes.

## Files you own

- `infra/terraform/**`
- `docs/adr/0002-realtime-transport.md`, `docs/adr/0013-security.md`, `docs/ARCHITECTURE.md`
- Report-only for `apps/web`.

## Acceptance criteria

1. `bash infra/terraform/validate.sh` passes (fmt, validate, mock tests, tflint).
2. No `/api/*` behaviour or HTTP API origin remains in CloudFront. CORS allows only the configured site origins.
3. The ADRs and ARCHITECTURE reflect the change, with the reason.
