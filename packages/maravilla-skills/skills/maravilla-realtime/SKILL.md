---
name: maravilla-realtime
description: "Maravilla Cloud realtime — server-side `platform.realtime.publish/channels/presence` for pub/sub and live rosters, browser `RenClient` (SSE) for change-notification streams from KV/DB/storage writes, and browser `RealtimeClient` (WebSocket) for direct channel pub/sub + presence. Use for chat, multiplayer, live dashboards, presence, or any feature that should push updates instead of polling. All client classes import from `@maravilla-labs/platform` (root) — there is no `/realtime` subpath."
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

## REN — change notifications over SSE (`RenClient`)

Whenever you `kv.put`, `db.insertOne`, `storage.put`, `rt.publish`, etc., the platform emits a REN event. Browsers connect with `RenClient` (a thin SSE client) and register a single listener that fires for **every** event the connection is subscribed to. **You filter inside the listener**, not in `subscribe(...)`.

### Imports

`RenClient` is exported from the **root** of `@maravilla-labs/platform`. There is no `@maravilla-labs/platform/realtime` subpath — package.json's `exports` map only ships `.`, `./config`, `./push`, `./events`.

```typescript
import { RenClient, getOrCreateClientId } from '@maravilla-labs/platform';
```

### Constructor

```typescript
new RenClient({
  endpoint?: string,           // override; defaults to /api/maravilla/ren
  subscriptions?: string[],    // resource-domain filter, e.g. ['kv', 'db']; default ['*']
  clientId?: string,           // persistent id; default getOrCreateClientId()
  autoReconnect?: boolean,     // default true
  maxBackoffMs?: number,       // default 15000
  debug?: boolean,             // default false (or localStorage.REN_DEBUG === '1')
});
```

`subscriptions` is a connection-time filter on the resource domain (`kv` / `db` / `storage` / `realtime` / `presence` / `runtime` / `transform` / etc.) — it cannot do per-key globbing. Use it to keep the SSE traffic small; do per-key matching inside the listener.

### `.on(listener) → unsubscribe`

```typescript
const ren = new RenClient({ subscriptions: ['kv'], debug: true });

const unsub = ren.on((event) => {
  // RenEvent shape: { t, r, k?, v?, ts?, src?, ns?, ch?, data?, uid? }
  // Filter for this view's data here:
  if (event.r === 'kv' && event.ns === 'demo' && event.k?.startsWith('todolist:42:item:')) {
    refreshTodos();
  }
});

// On unmount
unsub();
ren.close();
```

`RenEvent` keys:

- `t` — event type (`kv.put`, `db.document.created`, `storage.object.deleted`, `realtime.message`, `presence.join`, …).
- `r` — resource domain (`kv`, `db`, `storage`, `realtime`, `presence`, `runtime`, `transform`).
- `ns` — namespace (KV namespace, DB collection).
- `k` — key (KV key, doc id, storage path).
- `ch` — channel name (for `realtime.*` and `presence.*` events).
- `data` — payload for `realtime.message` publishes.
- `uid` — user id for `presence.*` events.
- `src` — origin client id; useful for *self-vs-others* filtering (`if (event.src === ren.getClientId()) return`).

### Helpers exported alongside `RenClient`

```typescript
import {
  getOrCreateClientId,    // () => string — persistent id in localStorage
  renFetch,               // fetch wrapper that injects the X-Ren-Client header
  storageUpload,          // (path, file)   POST /api/storage/upload
  storageDelete,          // (path)         DELETE /api/storage/delete
} from '@maravilla-labs/platform';
```

Use `renFetch` for any mutation that should attribute the change to *this* browser session — the server echoes `src` back on the REN event so other clients can distinguish your own writes from someone else's.

### Pattern: server writes, UI reflects

This is the canonical "no polling" pattern. The UI does **not** know about the publish channel — it subscribes to the SSE stream and filters on the data resource directly.

```typescript
// Initial fetch
const todos = await fetchTodos();

// Live updates via REN
const ren = new RenClient({ subscriptions: ['kv'] });
const unsub = ren.on((event) => {
  if (event.r === 'kv' && event.ns === 'demo' && event.k?.startsWith('todolist:')) {
    fetchTodos();
  }
});
```

When any backend code (your own routes, an `onKvChange` handler, a workflow step) does `kv.put('demo', 'todolist:1:item:abc', ...)`, the SSE stream fires and the UI re-fetches.

## `RealtimeClient` — direct WebSocket channels (browser)

For channel-scoped pub/sub + presence directly from the browser (without going through a server route to call `platform.realtime.publish`), use `RealtimeClient` — a WebSocket client with a real `.subscribe(channel, callback)` and a presence handle.

```typescript
import { RealtimeClient } from '@maravilla-labs/platform';

const rt = new RealtimeClient({ debug: true });
rt.connect();

// Subscribe to a channel
const unsub = rt.subscribe('room:42', (event) => {
  // event: { event, channel, data?, from?, userId?, ts?, metadata? }
  appendToView(event.data);
});

// Publish from the client
rt.publish('room:42', { type: 'message', text: 'hello' });

// Presence
const p = rt.presence('room:42');
p.join(userId, { name, avatar });
const offJoin  = p.onJoin((m) => addToRoster(m));
const offLeave = p.onLeave((m) => removeFromRoster(m));

// On unmount
unsub();
offJoin();
offLeave();
p.leave();
rt.disconnect();
```

`RealtimeClientOptions`: `wsEndpoint?`, `clientId?`, `autoReconnect?` (default true), `maxBackoffMs?` (default 15000), `debug?`. Use `rt.onAny(cb)` for a global listener across all subscribed channels. `rt.isConnected()` for status.

### `RenClient` vs `RealtimeClient` — pick one

| Need | Use |
|---|---|
| React to *any* KV/DB/Storage write | `RenClient` (SSE) — single connection, filter in listener |
| Direct channel pub/sub from the browser | `RealtimeClient` (WS) — per-channel `subscribe`/`publish` |
| Live presence roster joined from the client | `RealtimeClient.presence(channel)` |
| Server publishes a channel, client just listens | `RenClient` filtering on `event.r === 'realtime' && event.ch === '…'` works too |

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
  await getPlatform().realtime.publish(`room:${roomId}`, { type: 'message', text, from: me.user_id, ts: Date.now() });
  return new Response(null, { status: 204 });
}

// Client option A: RenClient (SSE) — filter realtime.message events on the channel
const ren = new RenClient({ subscriptions: ['realtime'] });
ren.on((event) => {
  if (event.t === 'realtime.message' && event.ch === `room:${roomId}`) {
    appendToView(event.data);
  }
});

// Client option B: RealtimeClient (WS) — per-channel subscribe
const rt = new RealtimeClient(); rt.connect();
rt.subscribe(`room:${roomId}`, (event) => appendToView(event.data));
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
const ren = new RenClient({ subscriptions: ['kv'] });
ren.on((event) => {
  if (event.r === 'kv' && event.ns === 'demo' && event.k === `stats:${listId}`) refresh();
});
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

- **Import from the root, not a subpath.** `import { RenClient } from '@maravilla-labs/platform'` ✓. `from '@maravilla-labs/platform/realtime'` ✗ — that subpath does not exist. Same for `RealtimeClient`.
- **`RenClient` has no `.subscribe(filter, callback)`.** Register a listener with `.on(callback)` and filter inside it on `event.r` / `event.t` / `event.ns` / `event.k` / `event.ch`. The constructor's `subscriptions: string[]` only filters on resource domain (`kv`, `db`, …), not per-key.
- **`RealtimeClient.subscribe(channel, callback)` is a different method on a different class.** Don't confuse the two — `RenClient` is SSE for raw resource events; `RealtimeClient` is WS for channel pub/sub.
- **Don't poll.** The whole point of REN is to skip `setInterval` / `setTimeout`-based polling. Subscribe and re-fetch.
- **Always unsubscribe on unmount.** Otherwise you leak event listeners and risk memory growth in long-lived sessions. Call the function returned by `.on()` / `.subscribe()`, then `ren.close()` / `rt.disconnect()`.
- **Filter out your own writes.** REN echoes your own mutations back. Use `event.src === ren.getClientId()` to drop self-originated events when needed.
- **Presence isn't durable.** Don't rely on `presence.members` for billing or audit — it's a best-effort live roster. Persist permanent state to KV/DB.
- **Channel naming matters.** Use a stable convention so handlers can use globs (`room:*`) without false matches.

## Related skills

- [maravilla-events](../maravilla-events/SKILL.md) — `onChannel`, `defineEvent`
- [maravilla-kv](../maravilla-kv/SKILL.md), [maravilla-db](../maravilla-db/SKILL.md) — the writes that fire REN events
- [maravilla-push](../maravilla-push/SKILL.md) — for delivery to *offline* devices
- [maravilla-workflows](../maravilla-workflows/SKILL.md) — `step.waitForEvent` for durable rendezvous

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
