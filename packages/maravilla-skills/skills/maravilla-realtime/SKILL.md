---
name: maravilla-realtime
description: "Maravilla Cloud realtime — `platform.realtime.publish/channels` for pub/sub, `presence.join/leave/members` for live rosters, plus the SSE-based `RenClient` for change-notification streams from KV/DB writes. Use to push live updates without polling, build chat/multiplayer/presence features, or wire UI subscriptions to backend writes."
---

# Maravilla Realtime

Two complementary surfaces:

- **`platform.realtime`** — server-side pub/sub channels and presence tracking.
- **REN (Real-time Event Notifications)** — SSE stream that fans KV/DB/storage writes out to subscribed browser clients.

Use `platform.realtime` for application-level channels (chat rooms, game state, "user is typing"). Use REN when you want the UI to live-update from data writes without designing a custom channel.

## `platform.realtime` — pub/sub + presence

```typescript
import { getPlatform } from '@maravilla-labs/platform';
const rt = getPlatform().realtime;
```

### `publish(channel, data, options?)`

```typescript
await rt.publish('room:42', { type: 'message', text: 'hello', from: userId });

// Tag the publish with the originating user (used by some subscribers)
await rt.publish('room:42', { type: 'typing' }, { userId });
```

Channels are free-form strings. Conventional shapes: `room:{id}`, `huddle:{groupId}`, `feed:{userId}`, `presence:{groupId}`.

### `channels()` — list active channels

```typescript
const live = await rt.channels();
// e.g. ['room:42', 'huddle:family', ...]
```

Useful for admin / observability surfaces.

### `presence` — join / leave / members

```typescript
await rt.presence.join('room:42', userId, { name: user.display_name, avatar: user.avatar });

const members = await rt.presence.members('room:42');
// [{ userId, metadata: { name, avatar }, lastSeen }, ...]

await rt.presence.leave('room:42', userId);
```

`metadata` is opaque to the platform — store whatever the UI needs to render. `lastSeen` is updated automatically on every interaction.

### Reacting to channel publishes server-side

Register an `onChannel` handler to derive state from publishes:

```typescript
// events/reflectHuddleCall.ts
import { onChannel } from '@maravilla-labs/platform/events';

export const reflectHuddleCall = onChannel(
  { channel: 'huddle:*', type: 'presence' },
  async (event, ctx) => {
    const groupId = event.channel.slice('huddle:'.length);
    const platform = ctx.platform as any;

    // Scan presence roster from KV; flip a "huddle-active" flag
    const listed = await platform.env.KV.demo.list({ prefix: `presence:${groupId}:`, limit: 100 });
    const anyInCall = (listed?.keys ?? []).some(/* ... */);

    if (anyInCall) await ctx.kv!.put('demo', `huddle-active:${groupId}`, '1', { ttl: 300 });
    else           await ctx.kv!.delete('demo', `huddle-active:${groupId}`);
  },
);
```

The `channel` filter supports glob wildcards (`huddle:*`); `type` filters on the publish's `type` field. See [maravilla-events](../maravilla-events/SKILL.md).

## REN — change notifications over SSE

Whenever you `kv.put`, `db.insertOne`, etc., the platform emits a REN event. Browsers connect with `RenClient` and subscribe to filters that match the resource shape.

### `RenClient` — minimal browser subscription

```typescript
import { RenClient } from '@maravilla-labs/platform/realtime';

const ren = new RenClient();   // auto-connects via SSE

// Subscribe to KV changes under a prefix
const sub = ren.subscribe(
  { r: 'kv', ns: 'demo', t: 'todolist:42:item:*' },
  (event) => {
    // Re-fetch and re-render
    refreshTodos();
  },
);

// Cleanup on unmount
sub.unsubscribe();
```

The match shape (`r`, `t`, `ns`) is the same one accepted by `defineEvent` server-side — it's the underlying RenEvent envelope. Common keys:

- `r` — resource type (`kv`, `db`, `storage`, `auth`, etc.)
- `ns` — namespace (KV namespace, DB collection)
- `t` — topic / key / glob — supports `*` wildcards

### Pattern: server writes, UI reflects

This is the canonical "no polling" pattern. The UI does **not** know about the channel — it subscribes to the data resource directly:

```typescript
// Initial fetch
const todos = await fetchTodos();

// Live updates via REN
const sub = ren.subscribe(
  { r: 'kv', ns: 'demo', t: 'todolist:*:item:*' },
  () => fetchTodos(),
);
```

When any backend code (your own routes, an `onKvChange` handler, a workflow step) does `kv.put('demo', 'todolist:1:item:abc', ...)`, the SSE stream fires and the UI re-fetches.

### Server-side `defineEvent` — listen to arbitrary REN events

Sometimes you want a server handler that doesn't fit `onKvChange` / `onDb` / `onStorage` — e.g. to react to a custom resource you've published. Use `defineEvent` as the escape hatch:

```typescript
import { defineEvent } from '@maravilla-labs/platform/events';

export const onCustomEvent = defineEvent(
  { match: { r: 'custom', ns: 'jobs', t: 'priority:high' } },
  async (event, ctx) => {
    // ... handle
  },
);
```

## Patterns

### Chat room

```typescript
// Server: publish on POST
export async function POST({ request }) {
  const { roomId, text } = await request.json();
  const me = platform.auth.getCurrentUser();
  await rt.publish(`room:${roomId}`, { type: 'message', text, from: me.user_id, ts: Date.now() });
  return new Response(null, { status: 204 });
}

// Client: subscribe via RenClient or direct SSE connection
ren.subscribe({ r: 'channel', t: 'room:42' }, (msg) => appendToView(msg.data));
```

### Presence-aware roster

```typescript
// On connect
await rt.presence.join(`room:${roomId}`, userId, { name, avatar });

// Periodic ping (or rely on auto-leave on disconnect)
const interval = setInterval(() => rt.presence.join(`room:${roomId}`, userId, meta), 15_000);

// On unmount
clearInterval(interval);
await rt.presence.leave(`room:${roomId}`, userId);
```

For UI components that need the full member list, poll `presence.members(channel)` on a slow cadence or subscribe to a derived flag (e.g. `huddle-active:{groupId}` written by an `onChannel` handler — see the demo's `reflectHuddleCall.ts`).

### Live dashboard backed by KV

Store a small derived "summary" doc in KV, write to it from event handlers, subscribe from the UI:

```typescript
// events/rollupTodoStats.ts — recalc on every item change
onKvChange({ namespace: 'demo', keyPattern: 'todolist:*:item:*' }, async (event, ctx) => {
  const stats = await recalc(/* ... */);
  await ctx.kv!.put('demo', `stats:${listId}`, JSON.stringify(stats));
});

// UI
ren.subscribe({ r: 'kv', ns: 'demo', t: `stats:${listId}` }, refresh);
```

## When to use what

| Need | Tool |
|---|---|
| "Tell every browser in this room something happened" | `rt.publish` + client SSE |
| "Who is currently in this room?" | `rt.presence` |
| "UI re-renders when this KV/DB changes" | REN — no channel needed |
| "Backend reacts to a publish" | `onChannel` handler |
| "Backend reacts to a custom event shape" | `defineEvent` handler |
| "Long-running workflow waits for an event" | `step.waitForEvent` — see [workflows](../maravilla-workflows/SKILL.md) |

## Pitfalls

- **Don't poll.** The whole point of REN is to skip `setInterval` / `setTimeout`-based polling. Subscribe and re-fetch.
- **Always unsubscribe on unmount.** Otherwise you leak SSE event listeners and risk memory growth in long-lived sessions.
- **Presence isn't durable.** Don't rely on `presence.members` for billing or audit — it's a best-effort live roster. Persist permanent state to KV/DB.
- **Channel naming matters.** Use a stable convention so handlers can use globs (`room:*`) without false matches.

## Related skills

- [maravilla-events](../maravilla-events/SKILL.md) — `onChannel`, `defineEvent`
- [maravilla-kv](../maravilla-kv/SKILL.md), [maravilla-db](../maravilla-db/SKILL.md) — the writes that fire REN events
- [maravilla-push](../maravilla-push/SKILL.md) — for delivery to *offline* devices
- [maravilla-workflows](../maravilla-workflows/SKILL.md) — `step.waitForEvent` for durable rendezvous

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
