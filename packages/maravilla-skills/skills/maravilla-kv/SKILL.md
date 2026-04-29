---
name: maravilla-kv
description: "Maravilla Cloud Key-Value storage — namespaced JSON blobs with `get / put / delete / list` and TTL via `expirationTtl`. Use for sessions, feature flags, capability tokens, presence rosters, small per-user state. Cloudflare-Workers-KV-shaped API exposed as `platform.env.KV.<namespace>`."
---

# Maravilla KV

Per-namespace JSON storage tuned for cheap reads and prefix-listing. Each project gets unlimited namespaces; you address them by name on `platform.env.KV.<namespace>`.

```typescript
import { getPlatform } from '@maravilla-labs/platform';

const platform = getPlatform();
const sessions = platform.env.KV.sessions;
const todos    = platform.env.KV.todos;
```

Namespaces are isolated from each other and from other tenants — Layer 1 is enforced unconditionally. If you've declared a matching `resource` in `maravilla.config.ts`, every op is also gated by that resource's Layer-2 policy.

## API

### `get(key)` → value | null

```typescript
const session = await sessions.get('session:abc123');
if (session) console.log(`Hi ${session.email}`);
```

Values are stored as JSON. The runtime parses on the way out — you get the original object back (not a string).

### `put(key, value, options?)`

```typescript
// Permanent
await todos.put('item:1', { text: 'Buy milk', done: false });

// With TTL — auto-deletes after expirationTtl seconds
await sessions.put(`session:${id}`, sessionData, { expirationTtl: 3600 });
```

`expirationTtl` is in **seconds**. Pass it whenever the data is recoverable from a system of record (sessions, presence pings, cached lookups) — TTL'd writes don't accumulate dead keys.

### `delete(key)`

```typescript
await sessions.delete('session:abc123');
```

### `list(options?)` → `{ keys, list_complete, cursor? }`

```typescript
// All keys (paginated)
const { keys, list_complete, cursor } = await todos.list({ prefix: 'item:', limit: 100 });

// Continue if there's more
if (!list_complete) {
  const next = await todos.list({ prefix: 'item:', limit: 100, cursor });
}
```

`keys[]` carries `{ name, expiration?, metadata? }`. Use `prefix` for hierarchical reads — combined with KV REN events (see [realtime](../maravilla-realtime/SKILL.md)) you get a "live folder" pattern with no polling.

## Key shapes that work well

KV's strengths are **cheap point reads** and **prefix scans**. Design keys around your read paths:

```
todolist:{listId}                       → list metadata
todolist:{listId}:item:{itemId}         → individual items (prefix-listable)

session:{sessionId}                     → opaque sessions (TTL)

presence:{groupId}:{userId}             → presence pings (short TTL, prefix-listable per group)

cap:{nanoid}                            → unguessable capability tokens for share links
```

Avoid embedding free-form user input in keys (path-traversal, length blowups). Stick to ids you minted.

## Reading a list with full values

`list()` returns names only. To fetch values too, do a parallel `get` round-trip:

```typescript
const { keys } = await todos.list({ prefix: 'item:', limit: 100 });
const items = await Promise.all(
  keys.map(async ({ name }) => ({ key: name, value: await todos.get(name) })),
);
```

For larger result sets prefer modeling as a DB collection — see [maravilla-db](../maravilla-db/SKILL.md).

## Reactivity: KV → events / REN

KV writes fan out to two listeners:

1. **Server-side handlers** registered with `onKvChange({ namespace, keyPattern, op })` — see [maravilla-events](../maravilla-events/SKILL.md). Use for derived state, denormalization, push triggers.
2. **Client-side REN subscriptions** via `RenClient` — see [maravilla-realtime](../maravilla-realtime/SKILL.md). Use to live-update the UI without polling.

Example handler that tags every new todo with a random emoji (note the recursion guard via `emojiTagged: true`):

```typescript
import { onKvChange } from '@maravilla-labs/platform/events';

export const tagNewTodoItem = onKvChange(
  { namespace: 'demo', keyPattern: 'todolist:*:item:*', op: 'put' },
  async (event, ctx) => {
    if (event.op !== 'put') return;
    const kv = ctx.kv as { get: any; put: any };

    const raw = await kv.get('demo', event.key);
    if (!raw) return;
    const item = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (item.emojiTagged === true) return;        // own-write guard

    item.text = `${item.text} 🎉`.trim();
    item.emojiTagged = true;
    await kv.put('demo', event.key, JSON.stringify(item));
  },
);
```

## TTL patterns

- **Sessions** — `expirationTtl: refresh_token_ttl_secs` keeps the session row alive only as long as it can be refreshed.
- **Presence** — write `expirationTtl: 30` and re-write every 10–15 seconds; missing pings auto-clear.
- **Idempotency** — `kv.put('idem:' + requestId, true, { expirationTtl: 600 })` blocks duplicate POSTs for 10 min.
- **Rate limits** — increment a counter under a 60-second TTL'd key to throttle per-IP/per-user.

## When to reach for DB instead

Move to `platform.env.DB` when you need:

- Multi-field filters (`{ owner, status, tag }`)
- Sorting (`sort: { createdAt: -1 }`)
- Compound indexes
- Vector search
- `$set` / `$inc` / `$push` mutations on individual fields
- `_id`-based lookups across hundreds of thousands of rows

KV is for "I know the exact key" or "give me everything under this prefix". DB is for "find rows that match these criteria".

## Pitfalls

- **Storing primitives as the top-level value.** Always wrap in an object — `{ value: 42 }` — so you can add fields later without a migration.
- **No transactions across keys.** A read-modify-write on two keys is racy. Either reduce to a single key, use the DB, or design idempotent merges.
- **No size guarantees on values.** Keep individual values under ~100 KB; for blobs use [storage](../maravilla-storage/SKILL.md).
- **Namespace names show up in policies.** If you add a Layer-2 policy on a resource, its `name` must match the KV namespace.

## Related skills

- [maravilla-overview](../maravilla-overview/SKILL.md) — when to use KV vs DB vs Storage
- [maravilla-events](../maravilla-events/SKILL.md) — `onKvChange` triggers
- [maravilla-realtime](../maravilla-realtime/SKILL.md) — live UI updates from KV writes
- [maravilla-policies](../maravilla-policies/SKILL.md) — resource gating

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
