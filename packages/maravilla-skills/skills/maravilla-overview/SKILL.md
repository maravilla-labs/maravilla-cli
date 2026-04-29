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
