---
name: maravilla-auth
description: "Maravilla Cloud authentication. Use whenever wiring login/register/session, OAuth callbacks, resource policies, or hitting `platform.auth.*` APIs. Critical: the 3-step request-scoped contract (validate → setCurrentUser → can) — skipping any step silently breaks Layer-2 policies and owner-scoped reads return empty with no error."
---

# Maravilla Cloud Auth

`platform.auth` exposes both the public auth surface (register / login / OAuth / refresh / password reset) and the **request-scoped identity binding** that every protected handler must run.

The hosted auth pages at `/_auth/login` and `/_auth/register` set a `__session` cookie containing a JWT access token. Your server code's job is to translate that cookie into a bound identity for the rest of the request.

## The 3-step contract — read this first

Every request that needs to act *as* an authenticated user must run these three steps in order:

1. **`validate(token)`** — confirm the JWT and return the `AuthUser`. If invalid, treat as anonymous.
2. **`setCurrentUser(token)`** — bind that identity to *this* request. Without this, every subsequent KV/DB/realtime/media op runs as anonymous, even though you have a valid `AuthUser` in hand.
3. **(optional) `can(action, resource, node?)`** — ask the policy engine, ahead of time, whether the bound caller is allowed to do something. The same evaluator gates direct ops, so `can()` is authoritative.

**Skipping step 2 is the single most common Maravilla bug.** Owner-scoped policies like `auth.user_id == node.owner` will see `auth.user_id == ""` and silently filter everything out. The UI shows an empty list. There is no error.

### Canonical SvelteKit `hooks.server.ts`

This is the verbatim pattern from the demo app — every SvelteKit Maravilla project should have something equivalent:

```typescript
import type { Handle } from '@sveltejs/kit';
import { getPlatform } from '@maravilla-labs/platform';

/**
 * Resolve the current user once per request, *before* any load runs.
 *
 * SvelteKit runs `load` functions in parallel by default. Putting the
 * session lookup in `+layout.server.ts` works for the layout's own data,
 * but child loads that read `event.locals.user` may fire before the
 * layout has written to it — leading to spurious redirects on pages
 * like `/invites` even when the topbar clearly shows a signed-in user.
 *
 * Hooks run once per request, serially, before any load. Whatever we set
 * on `event.locals` here is visible to every load in the tree.
 */
export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = null;

  const token = event.cookies.get('__session');
  if (token) {
    try {
      const platform = getPlatform();
      const user = await platform.auth.validate(token);
      // Bind identity for Layer-2 policies on any KV/DB/realtime/media
      // op that runs later in this request.
      await platform.auth.setCurrentUser(token);
      event.locals.user = user;
    } catch {
      // Stale / revoked / malformed token — treat as anonymous.
      // The browser still carries the cookie; the topbar will offer
      // Login/Register. We deliberately don't delete the cookie here:
      // clock skew or transient validation errors shouldn't log users
      // out. The user can log out explicitly via /logout.
    }
  }

  return resolve(event);
};
```

Two non-obvious choices to copy:

1. **Run in `hooks.server.ts`, not `+layout.server.ts`.** Layouts run in parallel with child loads — child loads can read `event.locals.user` before the layout writes to it. Hooks run serially before any load.
2. **Don't clear the cookie on validation failure.** Clock skew and transient errors shouldn't log a user out. Let the user log out explicitly.

The React Router 7 equivalent is in [maravilla-frameworks-react-router](../maravilla-frameworks-react-router/SKILL.md).

## Public APIs

### Register

```typescript
const user = await platform.auth.register({
  email: 'user@example.com',
  password: 'securePassword123',  // min 8 chars, plus your password_policy
  profile: { display_name: 'Alex' },  // custom fields configured in maravilla.config.ts
});
// user.email_verified === false until verifyEmail()
```

`profile` carries whatever custom fields you declared under `auth.registration.fields` in your config. The fields surface as `event.data.profile` in any `onAuth({ op: 'registered' })` handler — that's the canonical place to mint your app-side `users` doc.

### Login

```typescript
const session = await platform.auth.login({
  email: 'user@example.com',
  password: 'securePassword123',
});
// session.access_token   — short-lived JWT (default 15 min)
// session.refresh_token  — single-use opaque token (default 30 days)
// session.expires_in     — seconds
// session.user           — AuthUser
```

`login()` *implicitly* binds the caller for the remainder of the request. You don't need to call `setCurrentUser` after a successful `login`.

### OAuth

```typescript
// 1. Start the flow
const { auth_url, state } = await platform.auth.getOAuthUrl('google', {
  redirectUri: 'https://myapp.com/auth/callback',
});
// Persist `state` (cookie or KV) for CSRF verification, then redirect.

// 2. Handle the callback
const result = await platform.auth.handleOAuthCallback('google', {
  code: url.searchParams.get('code')!,
  state: url.searchParams.get('state')!,
});

if ('access_token' in result) {
  // AuthSession — user is authenticated
  return setSessionCookieAndRedirect(result);
} else {
  // { type: 'LinkRequired', email, provider, provider_id, existing_user_id }
  // The OAuth identity belongs to a different existing account; ask the user
  // to log into that account and link the provider explicitly.
}
```

Supported providers: `google`, `github`, `okta`, `custom_oidc`. Configure them in `maravilla.config.ts` under `auth.oauth` — see [maravilla-config](../maravilla-config/SKILL.md).

### Refresh

```typescript
const newSession = await platform.auth.refresh(refresh_token);
// Old refresh_token is now invalid (single-use)
```

### Logout / password / email

```typescript
await platform.auth.logout(sessionId);

await platform.auth.sendPasswordReset(email);  // returns { token } — caller delivers
await platform.auth.resetPassword(token, newPassword);
await platform.auth.changePassword(userId, oldPassword, newPassword);

await platform.auth.sendVerification(userId);  // returns { token }
await platform.auth.verifyEmail(token);
```

## Request-scoped identity

These methods are **only available inside the runtime** (during a Deno isolate request). They throw on remote clients (e.g. when running CLI scripts):

### `setCurrentUser(token)` — explicit bind

```typescript
await platform.auth.setCurrentUser(token);     // bind from a JWT
await platform.auth.setCurrentUser(null);       // clear → anonymous
```

Use after extracting a token from an inbound `Authorization` header or session cookie.

### `getCurrentUser()` — snapshot

```typescript
const caller = platform.auth.getCurrentUser();
// {
//   user_id: string,        // "" if anonymous
//   email: string,
//   is_admin: boolean,
//   roles: string[],        // project-scoped role names
//   is_anonymous: boolean,
// }
```

This is exactly what Layer-2 policies see as `auth.*`.

### `can(action, resource, node?)` — pre-check

```typescript
const ok = await platform.auth.can('delete', 'documents', {
  owner: doc.owner,
  status: doc.status,
});
if (!ok) return new Response('Forbidden', { status: 403 });
```

Runs the exact same evaluator as the direct op gate, so `can()` is authoritative. Returns a boolean; never throws on denial.

### `withAuth(handler)` — convenience middleware

```typescript
export default {
  fetch: platform.auth.withAuth(async (request) => {
    // request.user is guaranteed to be set; otherwise 401 JSON returned automatically
    const data = await platform.env.DB.find('items', { owner: request.user.id });
    return Response.json(data);
  }),
};
```

Extracts the token from `Authorization: Bearer <token>` or `__session` cookie, validates it, binds the caller, and injects `request.user`.

## Admin operations

```typescript
const user = await platform.auth.getUser(userId);

const page = await platform.auth.listUsers({
  limit: 50, offset: 0,
  status: 'active',
  email_contains: 'gmail.com',
  group_id: 'g_123',
});

await platform.auth.updateUser(userId, {
  email: 'new@example.com',
  status: 'suspended',
  profile: { tier: 'pro' },
});

await platform.auth.deleteUser(userId);
```

These bypass the normal user-facing endpoint and require the caller to be admin (or for Layer-2 to be off via `platform.policy.setEnabled(false)`).

## `AuthUser` shape

```typescript
interface AuthUser {
  id: string;                    // "usr_..."
  email: string;
  email_verified: boolean;
  status: 'active' | 'suspended' | 'deactivated';
  provider: string;              // "email" | "google" | "github" | ...
  groups: string[];              // group IDs
  created_at: number;            // unix seconds
  updated_at: number;
  last_login_at?: number;
}
```

## Common pitfalls

- **The "empty list" bug.** You called `validate()`, set `event.locals.user`, but skipped `setCurrentUser()`. Owner-scoped reads return zero rows because the policy engine sees an anonymous caller. Fix: always pair `validate` with `setCurrentUser` in your hook.
- **`setCurrentUser` thrown error on a remote client.** That method only works inside the runtime. CLI / Node scripts that hold a token can call public APIs but cannot bind a caller.
- **Mixing `withAuth` with manual binding.** `withAuth` already runs the contract; don't call `setCurrentUser` again inside the handler.
- **Caching `getCurrentUser()` across requests.** Don't. The caller is request-scoped — store the `event.locals.user` from your hook instead.

## Related skills

- [maravilla-config](../maravilla-config/SKILL.md) — declare resources, password policy, OAuth, registration fields
- [maravilla-policies](../maravilla-policies/SKILL.md) — the `auth.* / node.*` expression language
- [maravilla-events](../maravilla-events/SKILL.md) — `onAuth({ op: 'registered' })` for app-side user provisioning
- Framework patterns: [sveltekit](../maravilla-frameworks-sveltekit/SKILL.md), [react-router](../maravilla-frameworks-react-router/SKILL.md), [nuxt](../maravilla-frameworks-nuxt/SKILL.md)

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
