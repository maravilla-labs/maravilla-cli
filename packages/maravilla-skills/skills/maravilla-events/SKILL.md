---
name: maravilla-events
description: "Maravilla Cloud event handlers — files in `events/*.ts` auto-discovered by the framework adapter. Use to react to data changes (`onKvChange`, `onDb`), auth lifecycle (`onAuth`), schedule (`onSchedule`), queue messages (`onQueue`), realtime publishes (`onChannel`), deploy phases (`onDeploy`), object storage (`onStorage`), or arbitrary REN events (`defineEvent`). Run inside the Maravilla runtime with full platform access via `ctx`."
---

# Maravilla Events

Event handlers are TypeScript files under `events/` (or top-level `events.ts`) that the framework adapter discovers at build time. Each handler is a `RegisteredHandler` — a tuple of `{ trigger, handler }` produced by one of the `on*` factories from `@maravilla-labs/platform/events`.

```
my-app/
├── events/
│   ├── onUserRegistered.ts      # onAuth
│   ├── tagNewTodoItem.ts        # onKvChange
│   ├── reflectHuddleCall.ts     # onChannel
│   └── rollupTodoStats.ts       # onDb
└── maravilla.config.ts
```

The Rust dispatcher pulls trigger config out of the manifest and invokes your handler in the same isolate as your request code, with the full platform available on `ctx`.

## Trigger types

### `onKvChange` — KV writes

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

    // Recursion guard: our own put fires another kv event
    if (item.emojiTagged === true) return;

    item.text = `${item.text} 🎉`.trim();
    item.emojiTagged = true;
    await kv.put('demo', event.key, JSON.stringify(item));
  },
);
```

`event` shape: `{ op: 'put' | 'delete' | 'expired', namespace, key, value?, ts }`. `value` is present on some `put` events but you may need to re-read from KV to get the current state — design handlers to be safe against missing `value`.

### `onDbChange` — collection writes

```typescript
import { onDbChange } from '@maravilla-labs/platform/events';

export const onPostInsert = onDbChange(
  { collection: 'posts', op: 'insert' },
  async (event, ctx) => {
    // event: { op, collection, id, doc?, before?, after?, ts }
    await indexForSearch(event.id, event.doc);
  },
);
```

Useful for denormalization, search index sync, audit logs.

### `onAuth` — user lifecycle

```typescript
import { onAuth } from '@maravilla-labs/platform/events';

export const provisionUser = onAuth(
  { op: 'registered' },
  async (event, ctx) => {
    const db = ctx.database as any;
    const profile = event.data?.profile ?? {};
    await db.insertOne('users', {
      _id: event.userId,
      email: event.data?.email,
      display_name: profile.display_name ?? '',
      created_at: event.ts,
    });
  },
);
```

`op` values: `registered`, `logged_in`, `logged_out`, `logged_out_all`, `deleted`, `updated`. Omit `op` to match all auth events. The `event.data` shape per op:

- `registered` → `{ email, provider, profile }` (profile carries your custom registration fields)
- `logged_in` → `{ email }`
- `logged_out` → `{ sessionId }`
- `logged_out_all` / `deleted` / `updated` → null/empty

`onAuth({ op: 'registered' })` is the **canonical place** to mint your app-side `users` doc. See the React Router auth pattern in [maravilla-frameworks-react-router](../maravilla-frameworks-react-router/SKILL.md) for a lazy-fallback pattern that handles cases where the event handler hasn't run yet.

### `onSchedule` — cron

```typescript
import { onSchedule } from '@maravilla-labs/platform/events';

export const dailyDigest = onSchedule(
  '0 9 * * *',                 // every day at 09:00 UTC
  async (event, ctx) => {
    // event: { cron, scheduledAt, firedAt }
    const users = await (ctx.database as any).find('users', { digest_opted_in: true });
    for (const u of users) await ctx.platform.push.send({ userId: u._id }, /* ... */);
  },
);
```

Standard 5-field cron in UTC. Fires at most once per scheduled tick — won't run twice if the runtime restarts within the minute.

### `onQueue` — durable queue messages

```typescript
import { onQueue } from '@maravilla-labs/platform/events';

interface JobPayload { userId: string; reportId: string; }

export const reportBuilder = onQueue<JobPayload>(
  'reports',
  { batch: 10, maxAttempts: 3 },
  async (messages, ctx) => {
    for (const msg of messages) {
      // msg: { id, payload, attempt, enqueuedAt }
      await buildReport(msg.payload);
    }
  },
);
```

Producer side:

```typescript
await ctx.queue!.send('reports', { userId, reportId } satisfies JobPayload);
```

### `onChannel` — realtime publishes

```typescript
import { onChannel } from '@maravilla-labs/platform/events';

export const reflectHuddleCall = onChannel(
  { channel: 'huddle:*', type: 'presence' },
  async (event, ctx) => {
    // event: { channel, type, data?, uid?, ts }
    const groupId = event.channel.slice('huddle:'.length);
    /* derive state, write to KV */
  },
);
```

`channel` supports glob wildcards. `type` filters on the publish's `type` field — omit to match all publishes on the channel.

### `onStorage` — object uploads / deletes

```typescript
import { onStorage } from '@maravilla-labs/platform/events';

export const onPhotoUpload = onStorage(
  { keyPattern: 'uploads/photos/**', op: 'put' },
  async (event, ctx) => {
    // event: { op, key, contentType?, size?, ts }
    const platform = ctx.platform as any;
    await platform.media.transforms.resize(event.key, { width: 1600, format: 'webp' });
  },
);
```

`keyPattern` is glob-style. Omit `op` to match both `put` and `delete`; omit `keyPattern` to match every object in the tenant's bucket.

For **fixed transform pipelines** (resize / transcode / thumbnail), prefer the declarative `transforms` block in `maravilla.config.ts` — it compiles into a synthesized `onStorage` handler. Use a hand-written handler when you need branching logic. See [maravilla-config](../maravilla-config/SKILL.md), [maravilla-storage](../maravilla-storage/SKILL.md).

### `onDeploy` — runtime lifecycle

```typescript
import { onDeploy } from '@maravilla-labs/platform/events';

export const onReady    = onDeploy('ready',    async (event, ctx) => { /* warm caches */ });
export const onDraining = onDeploy('draining', async (event, ctx) => { /* flush state */ });
```

Phases: `ready`, `draining`, `stopped`. Useful for warm-up and graceful-shutdown work.

### `defineEvent` — escape hatch for custom REN events

```typescript
import { defineEvent } from '@maravilla-labs/platform/events';

export const onCustom = defineEvent(
  { match: { r: 'custom', ns: 'jobs', t: 'priority:high' } },
  async (event, ctx) => { /* handle */ },
);
```

For arbitrary RenEvent shapes that don't fit the named factories.

## Handler context (`ctx`)

Every handler receives an `EventCtx` with everything you need:

```typescript
{
  env: Record<string, string>,            // per-tenant env vars
  kv?: <kv adapter>,                      // KV — same shape as platform.env.KV
  database?: <db adapter>,                // DB — same shape as platform.env.DB
  storage?: <storage adapter>,            // Object storage
  queue?: { send: (name, payload, opts?) => Promise<string> },
  auth?: <auth adapter>,                  // platform.auth
  push?: <push adapter>,                  // platform.push
  platform?: <full platform>,             // escape hatch
  traceId: string,                        // propagate through logs
  tenant: string,
  handlerId: string,
}
```

Notes:

- The `kv` adapter on `ctx` doesn't currently expose `list()` in some runtime versions. Fall back to `(ctx.platform as any).env.KV.<namespace>.list({ prefix })` — this is the pattern used in production demo handlers.
- Always guard against missing services in defensive code:

```typescript
if (!ctx.kv) {
  console.warn('[events] handler: ctx.kv missing, skipping');
  return;
}
```

## Idempotency + safe re-delivery

The dispatcher may re-deliver an event after a transient failure. Handlers must be safe to run twice:

- **Recursion guards** for handlers that write to the same resource they listen on (see the emoji example above — `emojiTagged: true` on the doc short-circuits the loop).
- **Idempotency keys** for outbound side effects:

```typescript
const sentKey = `email-sent:${event.userId}:${event.op}`;
if (await ctx.kv!.get('idempotency', sentKey)) return;
await sendEmail(/* ... */);
await ctx.kv!.put('idempotency', sentKey, true, { expirationTtl: 86400 });
```

- **Conditional updates** that no-op if the work has been done:

```typescript
const existing = await db.findOne('users', { _id: event.userId });
if (existing) return;   // already provisioned by a previous delivery
await db.insertOne('users', /* ... */);
```

## When NOT to use an event

Reach for [maravilla-workflows](../maravilla-workflows/SKILL.md) instead when you need:

- A multi-step process where each step's output feeds the next
- Sleeps that span minutes/hours/days
- Waiting for external events (`step.waitForEvent`)
- Strict at-most-once semantics with full step history

Events are best for **single, fast, idempotent reactions** to a single trigger.

## Related skills

- [maravilla-config](../maravilla-config/SKILL.md) — declarative `transforms` instead of hand-written `onStorage`
- [maravilla-workflows](../maravilla-workflows/SKILL.md) — durable multi-step processes
- [maravilla-realtime](../maravilla-realtime/SKILL.md) — `onChannel` partner surface
- [maravilla-auth](../maravilla-auth/SKILL.md) — `onAuth({op:'registered'})` for user provisioning

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
