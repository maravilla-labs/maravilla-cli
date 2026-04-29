---
name: maravilla-frameworks-react-router
description: "Building React Router 7 (RR7, formerly Remix) apps on Maravilla Cloud with `@maravilla-labs/adapter-react-router`. Use when scaffolding/configuring an RR7 project, writing server loaders / actions, propagating auth via the loader pattern, and lazy-creating the app-side `users` doc to handle cases where the `onAuth({op:'registered'})` event handler hasn't run yet."
---

# Maravilla on React Router 7

`@maravilla-labs/adapter-react-router` is the RR7 adapter. Your build output ships ready for the Maravilla runtime; events / workflows under `events/` and `workflows/` are auto-discovered.

```bash
pnpm add -D @maravilla-labs/adapter-react-router
pnpm add @maravilla-labs/platform
```

Wire it in your `react-router.config.ts`:

```typescript
import type { Config } from '@react-router/dev/config';
import { adapter } from '@maravilla-labs/adapter-react-router';

export default {
  ssr: true,
  adapter: adapter(),
} satisfies Config;
```

## Auth in RR7 — server loader pattern

RR7 doesn't have a SvelteKit-style hook that runs before all loaders. The canonical pattern is a `getSession(request)` helper that runs the [3-step auth contract](../maravilla-auth/SKILL.md) and is called from any loader that needs the caller. This is the verbatim shape from the production university app:

```typescript
// app/lib/auth.server.ts
import { redirect } from 'react-router';
import { auth as platformAuth, DB } from './platform.server';
import type { User, UserRole } from './types';

type AuthUserLike = {
  id: string;
  email: string;
  email_verified?: boolean;
  groups?: string[];
  profile?: Record<string, unknown>;
};

export interface SessionUser {
  id: string;
  email: string;
  email_verified: boolean;
  roles: string[];
  groups: string[];
  is_admin: boolean;
}

/**
 * Resolve the caller's session (if any) from the platform.
 *
 * Three steps, all required:
 *   1. `validate(token)` confirms the JWT and returns the `AuthUser`.
 *   2. `setCurrentUser(token)` binds that identity for the rest of the
 *      request so subsequent DB/KV/Storage ops run as the user — without
 *      this bind, owner-scoped reads (including `users._id == auth.user_id`)
 *      resolve as anonymous and come back empty.
 *   3. `ensureUserDoc(u)` guarantees the app-side `users` doc exists. The
 *      `onAuth({op:'registered'})` handler is the primary creator; this
 *      lazy upsert rescues OAuth sign-ups, pre-handler accounts, or any
 *      case where the platform event didn't land. After this call, every
 *      protected loader can rely on the invariant *valid session ⇒ users
 *      doc present*.
 */
export async function getSession(request: Request): Promise<SessionUser | null> {
  const token = extractAccessToken(request);
  if (!token) return null;

  let u: AuthUserLike | null;
  try {
    u = (await platformAuth.validate(token)) as AuthUserLike | null;
  } catch {
    return null;
  }
  if (!u?.id) return null;

  await platformAuth.setCurrentUser(token);
  const appUser = await ensureUserDoc(u);
  return {
    id: u.id,
    email: u.email,
    email_verified: u.email_verified ?? false,
    roles: [appUser.role],
    groups: u.groups ?? [],
    is_admin: appUser.role === 'admin',
  };
}

export async function requireUser(request: Request): Promise<SessionUser> {
  const session = await getSession(request);
  if (!session) {
    const url = new URL(request.url);
    const next = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/_auth/login?next=${next}`);
  }
  return session;
}

/**
 * Extract the access token from the request.
 *
 * The Maravilla hosted pages (`/_auth/login`, `/_auth/register`) set the
 * `__session` cookie — that is the single source of truth. API clients may
 * also pass the same JWT via an `Authorization: Bearer` header.
 */
function extractAccessToken(request: Request): string | null {
  const authz = request.headers.get('authorization');
  if (authz?.startsWith('Bearer ')) return authz.slice(7);
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  const sessionMatch = cookie.match(/(?:^|;\s*)__session=([^;]+)/);
  return sessionMatch ? decodeURIComponent(sessionMatch[1]) : null;
}
```

Two crucial details to copy:

1. **`setCurrentUser(token)` MUST run before any DB/KV/Storage op.** Skipping it makes every owner-scoped read return zero rows because the policy engine sees an anonymous caller. There is no error — just empty data.
2. **`validate` failures are anonymous; `setCurrentUser` / `ensureUserDoc` failures are 500s.** A bad token is benign (treat as logged-out). A failure binding identity or provisioning the user doc is a contract violation — surface it, don't hide it as anonymous, otherwise the loader redirects to `/_auth/login` and loops forever.

## Lazy `ensureUserDoc` — handles missed `onAuth` events

The `onAuth({op:'registered'})` event handler is the **canonical** place to mint the app-side `users` doc. But OAuth sign-ups, pre-handler accounts, and rare event-delivery misses can leave a valid session without a corresponding `users` row. The lazy fallback in `getSession` rescues those cases:

```typescript
async function ensureUserDoc(u: AuthUserLike): Promise<User> {
  const existing = (await DB.findOne('users', { _id: u.id })) as User | null;
  if (existing) return existing;

  const now = Date.now();
  const profile = u.profile ?? {};
  const displayName =
    (typeof profile.display_name === 'string' ? profile.display_name : undefined)
    ?? (u.email ? u.email.split('@')[0] : 'New user');

  const doc: User = {
    _id: u.id,
    display_name: displayName,
    email: u.email ?? '',
    role: 'student',
    created_at: now,
    /* ... */
  };

  try {
    await DB.insertOne('users', doc);
    return doc;
  } catch (err) {
    // Concurrent insert race — re-read; if a sibling won, return its doc
    const raced = (await DB.findOne('users', { _id: u.id })) as User | null;
    if (raced) return raced;
    throw err;
  }
}
```

Keep `ensureUserDoc` and the registration event handler in lockstep when either changes — duplication is intentional (the handler runs in a different runtime so a shared helper costs more than it saves).

## Using session in loaders

```typescript
// app/routes/dashboard.tsx
import { getSession, requireUser } from '~/lib/auth.server';
import { DB } from '~/lib/platform.server';
import type { Route } from './+types/dashboard';

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUser(request);    // throws redirect to /_auth/login if no session

  const myItems = await DB.find('items', { owner_id: session.id }, { limit: 50 });

  return { session, myItems };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  return (
    <div>
      <h1>Welcome, {loaderData.session.email}</h1>
      <ul>{loaderData.myItems.map((i) => <li key={i._id}>{i.title}</li>)}</ul>
    </div>
  );
}
```

## Actions for mutations

```typescript
// app/routes/items.tsx
import { redirect } from 'react-router';
import { requireUser } from '~/lib/auth.server';
import { DB } from '~/lib/platform.server';

export async function action({ request }: Route.ActionArgs) {
  const session = await requireUser(request);
  const fd = await request.formData();
  const op = fd.get('_op');

  if (op === 'create') {
    await DB.insertOne('items', {
      title: String(fd.get('title')),
      owner_id: session.id,
      created_at: Date.now(),
    });
    return { ok: true };
  }

  if (op === 'delete') {
    const id = String(fd.get('id'));
    await DB.deleteOne('items', { _id: id });
    return { ok: true };
  }

  throw new Response('Unknown op', { status: 400 });
}
```

The Layer-2 policy on `items` (e.g. `auth.user_id == node.owner_id || auth.is_admin`) prevents one user from deleting another's items even if they forge the form.

## Role gates

```typescript
export async function requireStaff(request: Request): Promise<SessionUser> {
  const session = await requireUser(request);
  if (!(session.roles.includes('teacher') || session.is_admin)) {
    throw new Response('Forbidden', { status: 403 });
  }
  return session;
}

export async function requireAdmin(request: Request): Promise<SessionUser> {
  const session = await requireUser(request);
  if (!(session.roles.includes('admin') || session.is_admin)) {
    throw new Response('Forbidden', { status: 403 });
  }
  return session;
}
```

## Logout

```typescript
// app/routes/logout.tsx
import { redirect } from 'react-router';

export async function action() {
  // Clear cookie via Set-Cookie header
  return redirect('/', {
    headers: {
      'Set-Cookie': '__session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax',
    },
  });
}
```

## `loadContext` — passing platform to RR7 framework code

The adapter wires `platform` into RR7's `loadContext` so framework-level code (root error boundaries, middleware-style wrappers) can reach it without a direct import:

```typescript
// inside a loader
export async function loader({ request, context }: Route.LoaderArgs) {
  const { platform } = context;
  const settings = await platform.env.KV.config.get('app');
  return { settings };
}
```

Most code prefers the direct `import { getPlatform } from '@maravilla-labs/platform'` form — `loadContext` is for cases where you'd otherwise need to inject the import.

## Common pitfalls

- **Forgetting `setCurrentUser` in `getSession`.** The single most common bug — see [maravilla-auth](../maravilla-auth/SKILL.md). Symptom: empty arrays on owner-scoped queries.
- **Returning `null` from `getSession` on `setCurrentUser` failure.** That swallows a contract violation; the loader then redirects to login forever. Throw or 500 instead — only `validate` failures should produce a clean anonymous result.
- **Skipping `ensureUserDoc`.** OAuth users won't have an app-side `users` row until they hit a code path that creates one — make `getSession` the single guarantor.
- **Hard-coded HARDCODED_ADMIN_EMAILS.** Project-owner-style admin promotion is fine to bake in; just keep the same list in `ensureUserDoc` and any role-recompute path.

## Related skills

- [maravilla-auth](../maravilla-auth/SKILL.md) — the 3-step contract reference
- [maravilla-events](../maravilla-events/SKILL.md) — `onAuth({op:'registered'})` provisioning
- [maravilla-policies](../maravilla-policies/SKILL.md) — the `auth.user_id == node.owner_id` gate
- [maravilla-frameworks-sveltekit](../maravilla-frameworks-sveltekit/SKILL.md) — the equivalent SvelteKit pattern

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
