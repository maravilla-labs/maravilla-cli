---
name: maravilla-frameworks-sveltekit
description: "Building SvelteKit apps on Maravilla Cloud with `@maravilla-labs/adapter-sveltekit`. Use when scaffolding/configuring a SvelteKit project, wiring `hooks.server.ts` to bind auth from the `__session` cookie, writing `+page.server.ts` loads / form actions that hit `platform.env.KV/DB/STORAGE`, or debugging the 'logged in but data is empty' bug."
---

# Maravilla on SvelteKit

`@maravilla-labs/adapter-sveltekit` is the SvelteKit adapter — install it as your `kit.adapter` and your build output ships ready for the Maravilla runtime. The framework adapter discovers `events/*.ts` and `workflows/*.ts` at build time and includes them in the deployed manifest.

## Install + wire the adapter

```bash
pnpm add -D @maravilla-labs/adapter-sveltekit
pnpm add @maravilla-labs/platform
```

```javascript
// svelte.config.js
import adapter from '@maravilla-labs/adapter-sveltekit';

export default {
  kit: {
    adapter: adapter(),
  },
};
```

## The single most important file: `src/hooks.server.ts`

This file is non-negotiable for any project with auth. It runs the [3-step auth contract](../maravilla-auth/SKILL.md) once per request, before any `load` function fires. Skipping `setCurrentUser(token)` here is the root cause of the "logged in but seeing empty data" bug — Layer-2 policies see an anonymous caller and silently filter out the user's own rows.

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

Type the `locals.user` shape:

```typescript
// src/app.d.ts
import type { AuthUser } from '@maravilla-labs/platform';

declare global {
  namespace App {
    interface Locals {
      user: AuthUser | null;
    }
  }
}

export {};
```

## Why hook (not `+layout.server.ts`)

SvelteKit fires `load` functions in parallel, including across layout/child boundaries. A child route's load can read `event.locals.user` before the layout has written it — your `/invites` page redirects to login despite the topbar showing the user logged in. The hook runs once, serially, before any load — this is the only race-free spot to bind identity.

## `+page.server.ts` loads

Inside any server load, `event.locals.user` is your authenticated user (or `null`). The platform is bound to that identity for the duration of the request, so DB/KV/Storage ops just work:

```typescript
// src/routes/dashboard/+page.server.ts
import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getPlatform } from '@maravilla-labs/platform';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, '/_auth/login');

  const platform = getPlatform();
  const todos = await platform.env.KV.todos.list({ prefix: `user:${locals.user.id}:` });
  const profile = await platform.env.DB.findOne('users', { _id: locals.user.id });

  return {
    user: locals.user,
    todos: todos.keys,
    profile,
  };
};
```

Layer-2 policies (declared in `maravilla.config.ts`) gate every op — owner-only resources will only return the current user's rows even if you forget to filter.

## Form actions for KV / DB CRUD

```typescript
// src/routes/todos/+page.server.ts
import type { Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { getPlatform } from '@maravilla-labs/platform';
import { nanoid } from 'nanoid';

export const actions: Actions = {
  create: async ({ request, locals }) => {
    if (!locals.user) throw redirect(302, '/_auth/login');

    const data = await request.formData();
    const text = String(data.get('text') ?? '').trim();
    if (!text) return fail(400, { error: 'text required' });

    const platform = getPlatform();
    const id = nanoid();
    await platform.env.KV.todos.put(`user:${locals.user.id}:item:${id}`, {
      id, text, done: false, owner: locals.user.id, createdAt: Date.now(),
    });

    return { success: true };
  },

  toggle: async ({ request, locals }) => {
    if (!locals.user) throw redirect(302, '/_auth/login');
    const data = await request.formData();
    const key = String(data.get('key'));
    const platform = getPlatform();

    const item = await platform.env.KV.todos.get(key);
    if (!item) return fail(404);
    item.done = !item.done;
    await platform.env.KV.todos.put(key, item);
    return { success: true };
  },

  delete: async ({ request, locals }) => {
    if (!locals.user) throw redirect(302, '/_auth/login');
    const data = await request.formData();
    await getPlatform().env.KV.todos.delete(String(data.get('key')));
    return { success: true };
  },
};
```

The Layer-2 policy on `todos` (e.g. `auth.user_id == node.owner`) ensures users can't toggle/delete each other's items even if they craft a different `key`.

## Hosted auth pages

Maravilla ships hosted login / register / OAuth pages at `/_auth/*`. They set the `__session` cookie that your hook reads. Branding for these pages is declared in `maravilla.config.ts` under `auth.branding`.

Your app handles **logout** by clearing the cookie and (optionally) calling `platform.auth.logout(sessionId)`:

```typescript
// src/routes/logout/+server.ts
import type { RequestHandler } from './$types';
import { redirect } from '@sveltejs/kit';

export const POST: RequestHandler = async ({ cookies }) => {
  cookies.delete('__session', { path: '/' });
  throw redirect(303, '/');
};
```

## Login redirect pattern

```typescript
// src/routes/protected/+page.server.ts
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    const next = encodeURIComponent(url.pathname + url.search);
    throw redirect(302, `/_auth/login?next=${next}`);
  }
  // ...
};
```

The hosted login page reads `next` and bounces back after success.

## Reactive client-side updates with REN

Server `load` returns the snapshot. For live updates, subscribe via `RenClient` in a Svelte component:

```svelte
<!-- src/routes/todos/+page.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { RenClient } from '@maravilla-labs/platform/realtime';
  import { invalidateAll } from '$app/navigation';

  export let data;

  let ren: RenClient;
  let sub: { unsubscribe: () => void } | null = null;

  onMount(() => {
    ren = new RenClient();
    sub = ren.subscribe(
      { r: 'kv', ns: 'todos', t: `user:${data.user.id}:item:*` },
      () => invalidateAll(),  // re-run the +page.server.ts load
    );
  });

  onDestroy(() => sub?.unsubscribe());
</script>
```

## Events + workflows live alongside

```
my-app/
├── events/                      # auto-discovered by the adapter
│   ├── onUserRegistered.ts      # provision app-side users doc
│   └── tagNewTodoItem.ts
├── workflows/
│   └── inviteeClickWatch.ts
├── maravilla.config.ts
├── src/
│   ├── hooks.server.ts          # ⚠️ the 3-step contract
│   └── routes/
└── svelte.config.js
```

The adapter bundles these into the deployed manifest. See [maravilla-events](../maravilla-events/SKILL.md), [maravilla-workflows](../maravilla-workflows/SKILL.md).

## Common pitfalls

- **Putting auth-binding in `+layout.server.ts`.** Doesn't survive parallel child loads — use `hooks.server.ts`.
- **Calling `setCurrentUser` from inside a `+page.server.ts`.** Too late — child loads ran in parallel and are already returning empty results. Bind in the hook.
- **Returning `locals.user` from layout when it's already on `data`.** SvelteKit dedupes — fine — but layout-only state can confuse cached SSR. Keep the hook as the single source of truth.
- **Hard-coding `'/_auth/login'`.** Stable as the hosted endpoint; the URL shape doesn't change across versions.

## Related skills

- [maravilla-auth](../maravilla-auth/SKILL.md) — full 3-step contract reference
- [maravilla-config](../maravilla-config/SKILL.md) — `auth.branding`, OAuth, registration fields
- [maravilla-events](../maravilla-events/SKILL.md) — `onAuth({op:'registered'})` for `users` doc provisioning
- [maravilla-realtime](../maravilla-realtime/SKILL.md) — `RenClient` for live UI updates

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
