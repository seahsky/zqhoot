# auth

Host sign-in with Cognito ([ADR-0009](../../../../docs/adr/0009-auth-and-identity.md)). Players are
anonymous and never touch this.

## Resources

- **User pool** `{name}-hosts`: `ESSENTIALS` tier (free up to 10,000 monthly active users), email as
  the username, self sign-up off unless `allow_self_signup`, passwords of at least 12 characters,
  MFA optional (authenticator app only, because SMS needs an SNS role and per-message fees),
  deletion protection off unless asked. Usernames are case-insensitive (`Alice@example.com` and
  `alice@example.com` are one account). It is set explicitly because Cognito cannot change it after
  the pool exists, and it is not a variable for the same reason.
- **Hosted domain** `https://{domain_prefix}.auth.{region}.amazoncognito.com`. For `ESSENTIALS` and
  `PLUS` it uses managed login (`managed_login_version = 2`) with Cognito's default branding style;
  `LITE` falls back to the classic hosted UI.
- **Public app client** `{name}-web`: no secret, authorization code grant only (PKCE is what the
  single-page app does; Cognito cannot force it on for public clients), scopes `openid email profile`,
  identity provider `COGNITO` only, ID and access tokens valid 1 hour, refresh token 30 days, user
  existence errors hidden, token revocation on. `explicit_auth_flows` is `ALLOW_USER_SRP_AUTH` and
  `ALLOW_REFRESH_TOKEN_AUTH`; the app never calls `InitiateAuth` itself.
- **Optional first host** (`initial_admin_email`): created without a password, so Cognito generates a
  temporary one and emails it. No password is ever in Terraform state.

## Inputs

| Name                  | Type         | Default        | Description                                                                  |
| --------------------- | ------------ | -------------- | ---------------------------------------------------------------------------- |
| `name`                | string       | required       | Names the user pool and client.                                              |
| `domain_prefix`       | string       | required       | Hosted domain prefix; unique in the Region; no `aws`, `amazon` or `cognito`. |
| `callback_urls`       | list(string) | required       | OAuth redirect URLs, for example `https://{site}/host`.                      |
| `logout_urls`         | list(string) | required       | Sign-out redirect URLs.                                                      |
| `user_pool_tier`      | string       | `"ESSENTIALS"` | `LITE`, `ESSENTIALS` or `PLUS`.                                              |
| `allow_self_signup`   | bool         | `false`        | Let anyone create an account.                                                |
| `mfa_configuration`   | string       | `"OPTIONAL"`   | `OFF`, `OPTIONAL` or `ON`.                                                   |
| `deletion_protection` | bool         | `false`        | Cognito deletion protection.                                                 |
| `initial_admin_email` | string       | `null`         | Create a first host and email it a temporary password.                       |

## Outputs

`user_pool_id`, `user_pool_arn`, `client_id`, `hosted_domain_url`, `issuer_url`
(`https://cognito-idp.{region}.amazonaws.com/{pool id}`), `callback_urls` and `logout_urls` (as
registered on the app client).

## Notes

- The user pool and domain do not depend on the callback URLs. Those contain the CloudFront domain,
  and CloudFront's response headers policy needs `hosted_domain_url`; only the app client sits on
  the callback side of that loop.
- Unverified against a real account: managed login with Cognito-provided default branding, and the
  app client's `explicit_auth_flows`.
