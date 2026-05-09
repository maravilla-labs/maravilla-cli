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

`AuthUser` is exported from `@maravilla-labs/platform` — `import type { AuthUser } from '@maravilla-labs/platform'`. Notes worth knowing without opening the file:

- `id` is `"usr_..."` (nanoid-prefixed).
- `status` is `'active' | 'suspended' | 'deactivated'`. Suspended users still authenticate but most policies should reject them — check explicitly.
- `provider` is the auth provider key (`"email"`, `"google"`, etc.) — match strings, not booleans.
- `groups` carries group IDs, not names — use `platform.policy` predicates rather than string-matching.
- `created_at` / `updated_at` / `last_login_at` are unix seconds (not ms).

## Common pitfalls

These are the silent killers — every one of them was a real production bug. **Read this list before writing auth code.**

### `auth.is_admin` is hardcoded `false` — never use it in policies

The auth context exposes both `auth.is_admin` and `auth.groups`. The first is **always `false`** in dev-server today and not consistently populated in production. **Any policy clause built on `auth.is_admin` is unreachable.** Use `auth.groups.contains("admin")` instead — that reads the live group graph from the request's `AuthSnapshot`.

```ts
// WRONG — always false
policy: 'auth.is_admin || node.value.owner == auth.user_id'

// RIGHT
policy: 'auth.groups.contains("admin") || node.value.owner == auth.user_id'
```

`auth.roles` is kept as a back-compat alias for `auth.groups` (same group-name array under both names) — new policies should use `auth.groups`.

### `user.groups` carries group **IDs**, not names

`AuthUser.groups` (returned from `validate` / `getUser` / `getCurrentUser`) is an array of `grp_…` IDs serialized into the JWT. **`user.groups.includes("admin")` is always false** — there is no name `"admin"` in there, only `["grp_7-PIvCd4aw-Z-…"]`.

For a JS-side admin check, resolve via `getUserGroups`:

```ts
const groups = await platform.auth.getUserGroups(user.id);
const isAdmin = groups.some((g) => g.name === 'admin');
```

Inside policies, `auth.groups.contains("admin")` works on **names** — the policy engine resolves the AuthSnapshot which carries names, not the JWT array of IDs. The two layers expose the same data under the same field name but with different value shapes; this trips up everyone.

### `addUserToGroup` takes a group_id, not a name

The platform method `platform.auth.addUserToGroup(userId, groupId)` expects the `grp_…` id. Passing the literal name `"admin"` silently fails server-side (or, in older runtimes, no-ops because the binding wasn't even registered). The pattern is always:

```ts
const group = await platform.auth.getGroupByName('admin');
if (!group?.id) {
  console.log('admin group not provisioned — auth-settings reconciler should have created it from maravilla.config.ts::groups');
  return;
}
await platform.auth.addUserToGroup(user.id, group.id);
```

The auth-settings reconciler creates declared groups at deploy time, so `getGroupByName` resolves reliably for any group declared in `maravilla.config.ts`.

### "Empty list" bug — skipped `setCurrentUser`

You called `validate()`, set `event.locals.user`, but skipped `setCurrentUser()`. Owner-scoped policies see `auth.user_id == ""` and silently filter everything out. The UI shows an empty list. There is no error. Always pair `validate` with `setCurrentUser` in your hook (or use `withAuth`).

### Logout cookies must mirror the platform's flags

The platform's auth-pages handler sets cookies with these exact flags on login:

| Cookie | Flags |
|---|---|
| `__session` | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `__refresh` | `HttpOnly; Secure; SameSite=Strict; Path=/_auth` |

A `Set-Cookie` deletion (`Max-Age=0`) only matches the original cookie when the **flags align**. Clearing without `Secure` (e.g., `__session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`) leaves the cookie in place and the user stays logged in. **Cleanest fix: don't reinvent logout — delegate to `/_auth/logout`.** The platform handler clears with the right flags AND server-side invalidates the session row via `delete_session_by_refresh_token` (otherwise a stolen access-token JWT works until expiry).

```tsx
// In your Navbar's sign-out button
<form method="post" action="/_auth/logout">
  <button type="submit">Sign out</button>
</form>
```

Same-origin form submits send the `__refresh` cookie + Origin header automatically; the platform's CSRF check passes.

### `setCurrentUser` doesn't fix expired tokens — server-side refresh does

When a user comes back >1 hour later (default access-token TTL) but their `__refresh` cookie is still valid, `validate(token)` throws `TokenExpired` and naively your loader bounces them to `/login`. The platform exposes `POST /_auth/refresh` which rotates the session using the `__refresh` cookie. Pattern: catch the validate failure, POST to `/_auth/refresh` server-side, take the response's `Set-Cookie` headers, and `throw redirect(request.url, { headers })` so the browser reissues the request with fresh cookies.

```ts
async function tryRefreshSession(request: Request): Promise<Headers | null> {
  const cookieHeader = request.headers.get('cookie') ?? '';
  if (!parseCookie(cookieHeader, '__refresh')) return null;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const res = await fetch(`${origin}/_auth/refresh`, {
    method: 'POST',
    headers: { cookie: cookieHeader, origin },
    redirect: 'manual',
  });
  if (!res.ok) return null;
  const out = new Headers();
  const setCookies = (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookies) setCookies.forEach((c) => out.append('Set-Cookie', c));
  else if (res.headers.get('set-cookie')) out.append('Set-Cookie', res.headers.get('set-cookie')!);
  return out;
}

// In getCurrentUser, on validate failure or missing __session but present __refresh:
const refreshHeaders = await tryRefreshSession(request);
if (refreshHeaders) throw redirect(request.url, { headers: refreshHeaders });
return null; // fall through to login redirect
```

### `setCurrentUser` errors on a remote client

That method only works inside the runtime. CLI / Node scripts that hold a token can call public APIs (`validate`, `register`, `login`) but cannot bind a caller. Test fixtures running outside an HTTP scope must use `runWithRequest(async () => …)` from `@maravilla-labs/platform` to open a request scope first.

### Mixing `withAuth` with manual binding

`withAuth` already runs the 3-step contract; don't call `setCurrentUser` again inside the handler.

### Caching `getCurrentUser()` across requests

Don't. The caller is request-scoped — store `event.locals.user` from your hook instead.

## Admin & groups — bootstrap and enforcement patterns

### Declare groups in `maravilla.config.ts`

```ts
auth: {
  groups: [
    {
      name: 'admin',
      description: 'Staff with paradies access',
      permissions: [
        { resource_name: 'partners', actions: ['read', 'write', 'delete', 'list'] },
        // …
      ],
    },
  ],
}
```

The auth-settings reconciler in delivery upserts these on every deploy — by the time your app code runs, the group exists in the auth.db with a stable `grp_…` id.

### Bootstrap an initial admin via env allowlist

A bootstrap admin can't have a pending invite (no admin exists yet to write it). Pattern: gate on env email allowlist, lookup the group by name, add the user to it.

```ts
// app/lib/auth.server.ts (excerpt)
function bootstrapAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS ?? 'founder@example.com';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function maybeBootstrapAdmin(user: AuthUser) {
  if (!bootstrapAdminEmails().includes(user.email.toLowerCase())) return;

  // Already a member? Resolve via getUserGroups (returns full AuthGroup[]
  // with .name field — NOT user.groups which is just IDs).
  const groups = await platform.auth.getUserGroups(user.id);
  if (groups.some((g) => g.name === 'admin')) return;

  const group = await platform.auth.getGroupByName('admin');
  if (!group?.id) return;
  await platform.auth.addUserToGroup(user.id, group.id);
}
```

Call this from your `getCurrentUser` hook on every login.

### Pre-signup admin invites

For inviting people who haven't registered yet (no `user_id` exists), declare a dedicated KV resource and key on email:

```ts
{
  name: 'admin_invites',
  type: 'kv',
  policy:
    'auth.groups.contains("admin") || ' +
    '(auth.email != "" && node.key == auth.email)',
}
```

On first login, the user reads + deletes their own invite (the `node.key == auth.email` clause permits it), and the bootstrap path adds them to the admin group. Don't squat invites in a generic admin-only resource — the chicken-and-egg (user can't read what would let them become admin) makes first-login flows 500.

### `isUserAdmin` for UI / route guards

```ts
export async function isUserAdmin(user: AuthUser | null): Promise<boolean> {
  if (!user) return false;
  const groups = await platform.auth.getUserGroups(user.id);
  return groups.some((g) => g.name === 'admin');
}
```

Don't write `user.groups.includes('admin')` — that's the IDs-vs-names trap. The runtime caches `AuthSnapshot` per request, so repeated `getUserGroups` calls within a request are amortized.

## Diagnostic logging — keep it on

Auth bugs are silent. A small fixed set of log lines in your `getCurrentUser` hook makes them debuggable in 30 seconds instead of hours:

```ts
console.log('[auth] cookie?', cookieHeader.length > 0, 'token len:', token?.length ?? 0);
const user = await platform.auth.validate(token);
console.log('[auth] validate ok →', JSON.stringify({ id: user.id, email: user.email, groups: user.groups }));
await platform.auth.setCurrentUser(token);
const bound = await platform.auth.getCurrentUser();
console.log('[auth] runtime caller AFTER setCurrentUser →', JSON.stringify(bound));
```

Three log lines tell you immediately whether the cookie reached you, validate succeeded, and the runtime sees the bound user. No PII beyond what you already have on `AuthUser`. Standing observability beats reactive debugging.

## Related skills

- [maravilla-config](../maravilla-config/SKILL.md) — declare resources, password policy, OAuth, registration fields
- [maravilla-policies](../maravilla-policies/SKILL.md) — the `auth.* / node.*` expression language
- [maravilla-events](../maravilla-events/SKILL.md) — `onAuth({ op: 'registered' })` for app-side user provisioning
- Framework patterns: [sveltekit](../maravilla-frameworks-sveltekit/SKILL.md), [react-router](../maravilla-frameworks-react-router/SKILL.md), [nuxt](../maravilla-frameworks-nuxt/SKILL.md)

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
