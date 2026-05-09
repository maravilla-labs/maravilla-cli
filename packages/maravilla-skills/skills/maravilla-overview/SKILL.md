---
name: maravilla-overview
description: "Maravilla Cloud platform overview — V8-isolate edge runtime that exposes KV, document DB, object storage, auth, realtime, push, durable workflows, and event triggers through a single `getPlatform()` entry point. Use first when starting any Maravilla project, when explaining the runtime model, or when picking which subsystem to use for a feature."
---

# Maravilla Cloud Overview

Maravilla Cloud is a secure, edge-deployed JavaScript runtime that ships with a full backend platform built in. You write a normal SvelteKit / React Router 7 / Nuxt app, declare your auth and resource policies in `maravilla.config.ts`, and the runtime hands your code a `platform` object with KV, document DB, object storage, auth, realtime channels, Web Push, durable workflows, and event handlers.

There is no separate "deploy a function" step — your framework's server bundle *is* the runtime, and the platform services are imported as a typed SDK.

## Runtime model

- Each request runs in a **Deno V8 isolate** (per-tenant). No shared state across tenants — Layer 1 isolation is unconditional.
- Cold starts target <100 ms; per-worker baseline is <50 MB.
- The runtime polyfills `URL`, `Request`/`Response`, streaming, `setTimeout`, etc., so framework code runs unchanged.
- Two production-grade backends ship: MongoDB-mode (`platform.env.DB`) and a `production-sqlite` feature flag for per-tenant SQLite (vector search lives here, see [maravilla-db](../maravilla-db/SKILL.md)).
- In **dev mode**, Vite runs on its usual port (5173) and a Rust dev-server on 3001 provides the platform APIs. The Vite plugin injects `platform` into SSR.

## Single entry point: `getPlatform()`

```typescript
import { getPlatform } from '@maravilla-labs/platform';

const platform = getPlatform();

// platform.env.KV.<namespace>      — key/value
// platform.env.DB                   — document DB (Mongo-style + vector)
// platform.env.STORAGE              — object storage / presigned URLs
// platform.auth                     — auth + identity binding + can()
// platform.policy                   — per-request Layer-2 toggle
// platform.realtime                 — pub/sub + presence
// platform.push                     — Web Push (server side)
// platform.workflows                — durable, replay-based workflows
// platform.media                    — optional, when media is configured
```

`getPlatform()` returns the same shape in dev and prod. In dev the calls are proxied to the Rust dev-server; in prod they short-circuit through the host runtime.

## What goes where

The most common confusion when starting out is which surface to use for which kind of state. Quick map:

| Need | Use | Notes |
|---|---|---|
| Small JSON blobs, sessions, feature flags | **KV** | Namespaced. TTL via `expirationTtl`. Prefix listing. |
| Structured data, queries, indexes | **DB** | Mongo-style filters + `$set`/`$inc`/`$push`. `createIndex`, `findSimilar` for vectors. |
| Files, images, video | **STORAGE** | Presigned upload URLs. `getAssetUrl()` for `<img src>`. |
| Pub/sub between tabs / users | **realtime** | `publish`, `channels`, `presence`. |
| Browser notifications | **push** | VAPID, idempotent `key`, recurring `everySeconds`. |
| Long-running, multi-step, durable | **workflows** | Replay model — `step.run`, `step.sleep`, `step.waitForEvent`. |
| React to data changes | **events** | `events/*.ts` files: `onKvChange`, `onDb`, `onAuth`, `onSchedule`, `onStorage`, `onChannel`, `onQueue`, `onDeploy`. |

## The auth contract is critical

If you wire anything user-facing, **read [maravilla-auth](../maravilla-auth/SKILL.md) before writing code**. Every request that touches KV/DB/Storage as an authenticated user must do three things, in order:

1. `platform.auth.validate(token)` — confirm the JWT
2. `platform.auth.setCurrentUser(token)` — bind identity for *this* request
3. Operate normally; Layer-2 policies will see `auth.user_id` on every op

Skipping step 2 silently makes the request anonymous. Owner-scoped policies (`auth.user_id == node.owner`) then return zero rows and the UI looks "broken" with no error.

## Pitfalls that bite — read before writing auth/policy code

The list below is the set of silent-killer bugs we hit while building real apps on Maravilla. Each is documented in depth in its dedicated skill; this section is the index so an agent picking up an auth or policy task knows what to watch for **before** producing code.

1. **`auth.is_admin` is dead.** Use `auth.groups.contains("admin")` in policies. `auth.is_admin` is hardcoded `false` in dev-server and inconsistent in production. → [maravilla-policies](../maravilla-policies/SKILL.md), [maravilla-auth](../maravilla-auth/SKILL.md).
2. **`user.groups` is IDs, `auth.groups` is names.** `AuthUser.groups` (JS) carries `grp_…` IDs; `auth.groups` (policy DSL) carries names. `user.groups.includes("admin")` is always false. For JS-side admin checks use `getUserGroups(user.id)` and check `g.name === 'admin'`.
3. **`addUserToGroup` takes a group_id, not a name.** Resolve via `getGroupByName('admin')` first. The auth-settings reconciler creates declared groups at deploy time, so by-name lookup is reliable for anything in `maravilla.config.ts::groups`.
4. **Action vocab differs per service.** `node.action` is `"read"/"write"/"delete"/"list"` for KV/DB but `"get"/"put"/"delete"/"list"/"get-metadata"/"upload-url"/"download-url"/"confirm"` for Storage. Mixing them silently denies. → [maravilla-policies](../maravilla-policies/SKILL.md).
5. **Storage `node.key` includes the bucket prefix.** `node.key.startsWith("templates/")` never matches when the SDK helper sends `my-bucket/templates/...`. KV `node.key` does NOT include the namespace. Storage-only quirk.
6. **`list` ops carry `node.prefix`, not `node.key`.** "Users can read AND list this prefix" needs separate clauses for each.
7. **First-login policies must check `node.key`, not just `node.value.owner`.** A user reading their own profile for the first time hits `node.value == null`. A value-only check denies the legitimate first-read case.
8. **Logout: delegate to `/_auth/logout`.** Don't clear cookies yourself — browsers ignore deletions whose `Secure`/`SameSite`/`Path` flags don't match the originals. The platform endpoint also invalidates the session row server-side. `<form method="post" action="/_auth/logout">`.
9. **Refresh on `TokenExpired`, server-side.** When validate fails but `__refresh` is around, POST to `/_auth/refresh`, take the new `Set-Cookie` headers, `throw redirect(request.url, { headers })`. Otherwise users get bounced to `/login` after the access-token TTL.
10. **`STORAGE.get` returns `Array<number>` from the native runtime.** Coerce to `Uint8Array` defensively — `obj instanceof Uint8Array ? obj : Array.isArray(obj) ? new Uint8Array(obj) : new Uint8Array(await new Response(obj).arrayBuffer())`. The runtime fix is tracked separately.
11. **Trusted server-side ops on admin-only resources.** When app code needs to read an admin-only resource on behalf of an unauth'd flow (e.g., a duplicate-check before a deal write), wrap the lookup in `platform.policy.setEnabled(false)` (per-request, audit-logged) or write a dedicated narrowly-scoped resource. Don't relax the global policy.
12. **`JSON.stringify` breaks `node.value_new` field access.** `KV.put(k, JSON.stringify(obj))` makes the runtime see `node.value_new` as a string, so `node.value_new.foo` silently evaluates to `null` and any value-side policy denies. If your policy reads fields off the incoming value, pass the object directly (`KV.put(k, obj)`) — the runtime serialises it for you. Key-only policies are unaffected. → [maravilla-policies](../maravilla-policies/SKILL.md).

Every item above was a real silent bug. **Keep diagnostic logging on `getCurrentUser` always** — `[auth] cookie? validate ok → runtime caller AFTER setCurrentUser` — three log lines reduce auth debugging from hours to seconds.

## Project layout

```
my-app/
├── maravilla.config.ts        # Declarative auth, resources, indexes, transforms
├── events/                    # Auto-discovered event handlers
│   ├── onUserRegistered.ts
│   └── tagNewTodoItem.ts
├── workflows/                 # Durable workflows (defineWorkflow)
│   └── inviteeClickWatch.ts
├── src/                       # Your framework code (SvelteKit / RR7 / Nuxt)
│   ├── hooks.server.ts        # Bind auth from cookie (3-step contract)
│   └── routes/...
└── package.json
```

The framework adapter (`@maravilla-labs/adapter-sveltekit`, `@maravilla-labs/adapter-react-router`, `@maravilla-labs/preset-nitro`) discovers `events/*.ts` and `workflows/*.ts` at build time and bundles them into the deployed manifest.

## Two layers of authorization

- **Layer 1 — tenant + owner isolation.** Always on. A request can never see another tenant's data, full stop. Not configurable.
- **Layer 2 — per-resource policies.** Declarative expressions in `maravilla.config.ts` like `auth.user_id == node.owner || auth.is_admin`. Evaluated on every KV/DB/realtime/media op against that resource. Can be temporarily disabled per-request via `platform.policy.setEnabled(false)` for trusted in-app flows (admin jobs, seeders) — every flip is audit-logged.

## Frameworks supported

- **SvelteKit** via `@maravilla-labs/adapter-sveltekit` — see [sveltekit](../maravilla-frameworks-sveltekit/SKILL.md)
- **React Router 7** via `@maravilla-labs/adapter-react-router` — see [react-router](../maravilla-frameworks-react-router/SKILL.md)
- **Nuxt / Nitro** via `@maravilla-labs/preset-nitro` — see [nuxt](../maravilla-frameworks-nuxt/SKILL.md)

Next.js is not supported.

## Hello, world

```typescript
// src/routes/+page.server.ts (SvelteKit)
import { getPlatform } from '@maravilla-labs/platform';

export async function load() {
  const platform = getPlatform();
  const todos = await platform.env.KV.todos.list({ prefix: 'item:' });
  return { todos: todos.keys };
}
```

That's it. The runtime tags the request with the caller's tenant + identity (provided your hook ran the 3-step contract), the policy engine gates access, and your KV namespace is per-project per-tenant.

## Where to go next

- **Configure auth + policies** → [maravilla-config](../maravilla-config/SKILL.md), [maravilla-auth](../maravilla-auth/SKILL.md), [maravilla-policies](../maravilla-policies/SKILL.md)
- **Pick your framework** → [sveltekit](../maravilla-frameworks-sveltekit/SKILL.md), [react-router](../maravilla-frameworks-react-router/SKILL.md), [nuxt](../maravilla-frameworks-nuxt/SKILL.md)
- **Reach for storage** → [kv](../maravilla-kv/SKILL.md), [db](../maravilla-db/SKILL.md), [storage](../maravilla-storage/SKILL.md)
- **React to changes** → [events](../maravilla-events/SKILL.md), [workflows](../maravilla-workflows/SKILL.md)
- **Real-time + push** → [realtime](../maravilla-realtime/SKILL.md), [push](../maravilla-push/SKILL.md)

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
