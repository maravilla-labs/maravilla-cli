---
name: maravilla-frameworks-nuxt
description: "Building Nuxt apps on Maravilla Cloud with `@maravilla-labs/preset-nitro`. Use when scaffolding/configuring a Nuxt project, writing Nitro server middleware to bind auth from the `__session` cookie, calling `platform.env.KV/DB/STORAGE` from server routes, or accessing platform endpoints from Nuxt's `useFetch`."
---

# Maravilla on Nuxt / Nitro

Maravilla integrates with Nuxt via Nitro — the underlying server framework. `@maravilla-labs/preset-nitro` configures Nitro to deploy to the Maravilla runtime, with events and workflows auto-discovered from the project root.

```bash
pnpm add -D @maravilla-labs/preset-nitro
pnpm add @maravilla-labs/platform
```

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  nitro: {
    preset: '@maravilla-labs/preset-nitro',
  },
});
```

## Auth in Nitro — server middleware

Like SvelteKit, Nitro has a per-request middleware hook that runs before any route handler. This is where you implement the [3-step auth contract](../maravilla-auth/SKILL.md). Skipping `setCurrentUser(token)` here makes every owner-scoped DB/KV op return empty data.

```typescript
// server/middleware/auth.ts
import { getPlatform } from '@maravilla-labs/platform';
import type { AuthUser } from '@maravilla-labs/platform';

declare module 'h3' {
  interface H3EventContext {
    user?: AuthUser | null;
  }
}

export default defineEventHandler(async (event) => {
  event.context.user = null;

  const cookies = parseCookies(event);
  const token = cookies.__session;
  if (!token) return;

  try {
    const platform = getPlatform();
    const user = await platform.auth.validate(token);
    // Critical: bind identity for Layer-2 policies on every later op
    await platform.auth.setCurrentUser(token);
    event.context.user = user;
  } catch {
    // Stale / revoked token — leave anonymous. Don't clear the cookie:
    // clock skew or transient errors shouldn't log users out.
  }
});
```

## Server routes — using `event.context.user`

```typescript
// server/api/todos/index.get.ts
import { getPlatform } from '@maravilla-labs/platform';

export default defineEventHandler(async (event) => {
  const user = event.context.user;
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });

  const platform = getPlatform();
  const list = await platform.env.KV.todos.list({ prefix: `user:${user.id}:` });

  return { todos: list.keys };
});
```

```typescript
// server/api/todos/index.post.ts
import { nanoid } from 'nanoid';
import { getPlatform } from '@maravilla-labs/platform';

export default defineEventHandler(async (event) => {
  const user = event.context.user;
  if (!user) throw createError({ statusCode: 401 });

  const body = await readBody<{ text: string }>(event);
  if (!body?.text?.trim()) throw createError({ statusCode: 400, statusMessage: 'text required' });

  const id = nanoid();
  await getPlatform().env.KV.todos.put(`user:${user.id}:item:${id}`, {
    id, text: body.text, done: false, owner: user.id, createdAt: Date.now(),
  });

  return { id };
});
```

The Layer-2 policy on `todos` enforces ownership server-side, regardless of what client code sends.

## Composables — `useFetch` against your endpoints

```vue
<!-- app/pages/todos.vue -->
<script setup lang="ts">
const { data, refresh } = await useFetch<{ todos: { name: string }[] }>('/api/todos');

async function addTodo(text: string) {
  await $fetch('/api/todos', { method: 'POST', body: { text } });
  await refresh();
}
</script>

<template>
  <ul>
    <li v-for="t in data?.todos" :key="t.name">{{ t.name }}</li>
  </ul>
</template>
```

`useFetch` runs server-side first then hydrates on the client; `$fetch` is fine for browser-side mutations. Both forward cookies, so the auth middleware sees the `__session` cookie on every request.

## Live updates with `RenClient`

```vue
<script setup lang="ts">
import { RenClient } from '@maravilla-labs/platform/realtime';

const { data, refresh } = await useFetch<{ todos: any[] }>('/api/todos');
const ren = ref<RenClient | null>(null);
let sub: { unsubscribe: () => void } | null = null;

onMounted(() => {
  ren.value = new RenClient();
  sub = ren.value.subscribe(
    { r: 'kv', ns: 'todos', t: 'user:*:item:*' },
    () => refresh(),
  );
});

onBeforeUnmount(() => sub?.unsubscribe());
</script>
```

## `useRuntimeConfig` for project metadata

Anything you need exposed to both server + client (e.g. project id, storage bucket) goes into `runtimeConfig`:

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      assetsBase: '/_assets',
    },
  },
});
```

Pair with `platform.env.STORAGE.getAssetUrl(...)` in server routes when generating image URLs.

## Hosted auth pages

Maravilla serves `/_auth/login`, `/_auth/register`, OAuth callback, and password reset pages directly — branding declared via `auth.branding` in `maravilla.config.ts`. Send users there to sign in and they come back with `__session` set.

Logout endpoint:

```typescript
// server/api/logout.post.ts
export default defineEventHandler((event) => {
  setCookie(event, '__session', '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax' });
  return sendRedirect(event, '/', 303);
});
```

## Events + workflows

```
my-app/
├── events/                            # auto-discovered
│   ├── onUserRegistered.ts
│   └── tagNewTodoItem.ts
├── workflows/
│   └── inviteeClickWatch.ts
├── maravilla.config.ts
├── server/
│   ├── middleware/auth.ts             # ⚠️ 3-step contract
│   └── api/
└── nuxt.config.ts
```

Both `events/` and `workflows/` live at the project root (next to `nuxt.config.ts`), not inside `server/`. The Nitro preset reads them at build time.

## Pitfalls

- **Putting auth-binding in a route-level middleware.** Use `server/middleware/` (which runs on every request) — not page-level Vue middleware (client-side / route-specific).
- **`useFetch` + cookies in dev.** The dev proxy forwards cookies; double-check by logging `event.context.user` server-side and confirming it's populated.
- **Calling `setCurrentUser` inside an API route handler.** Too late — any earlier middleware that touched DB ran as anonymous. Bind in the auth middleware so it covers the whole request.
- **Hard-coded `/_auth/login` redirect.** Stable as the hosted endpoint; safe to hard-code.

## Related skills

- [maravilla-auth](../maravilla-auth/SKILL.md) — full 3-step contract reference
- [maravilla-config](../maravilla-config/SKILL.md) — `auth.branding`, OAuth, registration fields
- [maravilla-events](../maravilla-events/SKILL.md) — `onAuth`, `onKvChange`, etc.
- [maravilla-realtime](../maravilla-realtime/SKILL.md) — `RenClient` for live UI
- [maravilla-frameworks-sveltekit](../maravilla-frameworks-sveltekit/SKILL.md), [maravilla-frameworks-react-router](../maravilla-frameworks-react-router/SKILL.md) — equivalent patterns

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
