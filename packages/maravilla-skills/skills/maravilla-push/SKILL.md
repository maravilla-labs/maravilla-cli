---
name: maravilla-push
description: "Maravilla Cloud Web Push — server `platform.push.send/schedule/cancelScheduled/listScheduled` with idempotent keys and recurring `everySeconds`, browser `registerPush({ topics, userId, swPath })` from `@maravilla-labs/platform/push`. Use for browser notifications, scheduled reminders, recurring digests, and per-user fan-out by topic."
---

# Maravilla Web Push

Browser-side opt-in via the standard Web Push API; server-side fan-out + scheduling via `platform.push`. The platform handles VAPID, subscription storage, retry, and idempotent scheduling.

`platform.push` is **optional** — it's only present when Web Push is enabled in project settings. The dev-server fallback may leave it `undefined`; check before use.

## Browser side

### Register a subscription

```typescript
import { registerPush } from '@maravilla-labs/platform/push';

const { subscriptionId } = await registerPush({
  topics: ['waitlist', 'invite:abc:rsvp'],
  userId: user?.id ?? null,
  visitorId: anonId,                 // optional — for anonymous opt-ins
  swPath: '/sw.js',                  // your service worker (default '/sw.js')
});
```

This:

1. Asks the browser for `Notification.permission`
2. Creates a `PushSubscription` with the project's VAPID public key
3. POSTs the subscription + topics to the platform
4. Returns the platform's `subscriptionId` — store it locally so you can `unregisterPush` later

Persist `subscriptionId` keyed by `topics` (or by user) in `localStorage` so you can offer a "turn off notifications" toggle:

```typescript
function storageKey(topics: string[]) {
  return `push:${[...topics].sort().join(',')}`;
}
localStorage.setItem(storageKey(topics), JSON.stringify({ subscriptionId, createdAt: Date.now() }));
```

### Unregister

```typescript
import { unregisterPush } from '@maravilla-labs/platform/push';

await unregisterPush(subscriptionId);
```

The server may also prune dead subscriptions automatically on send if the push service returns `gone` — `unregisterPush` 404s are fine to swallow:

```typescript
try { await unregisterPush(id); } catch (err) { /* sub already gone — log and move on */ }
```

### Service worker

You provide the service worker. Minimal handler:

```javascript
// public/sw.js
self.addEventListener('push', (event) => {
  const payload = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
      data: payload,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(self.clients.openWindow(url));
});
```

## Server side

### `send(target, notification)` — fan-out

```typescript
const report = await platform.push!.send(
  { topic: 'waitlist' },               // PushTarget
  {
    title: 'You\'re in',
    body: 'Your account is ready',
    url: '/dashboard',
  },
);
// report: { attempted, succeeded, gone, failed, errors? }
```

Blocks until every device has been tried. Use `sendBackground` instead when the request handler should return immediately:

```typescript
await platform.push!.sendBackground(target, notification);
```

### `PushTarget` — narrowing

All specified conditions must match for a subscription to receive the push:

```typescript
{ topic: 'waitlist' }                          // every sub tagged with this topic
{ userId: 'usr_42' }                           // every device for one user
{ userId: 'usr_42', topic: 'invite:abc:rsvp' } // narrow to a specific user×topic
{ userIds: ['usr_1', 'usr_2'] }                // batch
{ topics: ['waitlist', 'beta'] }               // OR across topics
{ visitorId: 'anon_abc', onlyActive: true }    // anonymous + active only
```

### `NotificationPayload`

```typescript
{
  title: string,                               // required
  body?: string,
  icon?: string,
  badge?: string,
  image?: string,
  tag?: string,                                // browsers dedupe on this
  url?: string,                                // navigated to on click
  data?: Record<string, unknown>,              // arbitrary JSON for the SW
  ttl?: number,                                // seconds the push service holds while offline
  urgency?: 'very-low' | 'low' | 'normal' | 'high',
}
```

## Scheduling

### One-shot reminders

```typescript
await platform.push!.schedule(
  { topic: `invite:${invite.id}` },
  { title: invite.title, body: 'Your event is in one hour' },
  {
    at: offsetBefore(invite.event_date, '1h'),  // Date or ISO-8601 string
    key: `invite:${invite.id}:reminder-1h`,     // idempotency key
  },
);
```

### Idempotent updates

`key` is project-scoped. Re-calling `schedule` with the same key **atomically replaces** the prior pending job. Safe to call on every save of an invite whose event date may move:

```typescript
// On every invite save:
await platform.push!.schedule(target, notification, {
  at: offsetBefore(invite.event_date, '1h'),
  key: `invite:${invite.id}:reminder-1h`,
});
```

### Recurring digests

`everySeconds` re-queues the job after every successful send:

```typescript
await platform.push!.schedule(
  { userId },
  { title: 'Your daily digest', url: '/digest' },
  {
    at: nextRunAt,
    key: `digest:${userId}`,
    everySeconds: 86_400,                       // every 24h
  },
);

// Stop the loop
await platform.push!.cancelScheduled(`digest:${userId}`);
```

### Inspect / cancel

```typescript
// Single
const job = await platform.push!.getScheduled(`digest:${userId}`);
// job: ScheduledJob | null

// List
const jobs = await platform.push!.listScheduled({ status: 'pending', limit: 50 });

// Stats
const stats = await platform.push!.queueStats();
// { pending, running, succeeded, failed }

// Cancel by key (idempotent)
const { canceled } = await platform.push!.cancelScheduled(key);
```

## Subscription admin

```typescript
// Filter
const subs = await platform.push!.list({
  topic: 'waitlist',
  onlyActive: true,
  limit: 100,
});

// Aggregate counts
const counts = await platform.push!.counts();
// { total, byTopic: [['waitlist', 1234], ...], byProvider: [['web-push', 5000], ...] }

// Remove
await platform.push!.unsubscribe(subscriptionId);
await platform.push!.unsubscribeByEndpoint(endpoint);
```

## VAPID config

```typescript
const cfg = await platform.push!.getVapidConfig();
// { vapidPublic, contactEmail, updatedAt }

// Rotate — every existing subscription stops working silently!
const newCfg = await platform.push!.rotateVapidKeys();
```

**Rotating VAPID invalidates every subscription** (browsers bind subs to the key they saw at subscribe time). Confirm with users before rotating; usually only done in response to a known key compromise.

## Patterns

### Per-invite RSVP reminder, idempotent

```typescript
async function rescheduleReminder(invite) {
  const key = `invite:${invite.id}:reminder-1h`;
  if (!invite.event_date) {
    await platform.push.cancelScheduled(key);
    return;
  }
  await platform.push.schedule(
    { topic: `invite:${invite.id}` },
    { title: invite.title, body: 'Your event is in one hour' },
    { at: new Date(invite.event_date - 3600_000), key, maxAttempts: 5 },
  );
}
```

Call `rescheduleReminder(invite)` on every save — the idempotency key replaces the pending job atomically.

### Anonymous → user upgrade

When an anonymous visitor signs up, re-tag their subs:

```typescript
// onAuth({op:'registered'}) handler
const subs = await platform.push.list({ visitorId: ctx.visitorId, onlyActive: true });
for (const sub of subs) {
  // The platform doesn't expose direct re-tag — easiest is unsubscribe + browser re-registers with userId
}
```

In practice the browser's `registerPush` is idempotent on endpoint, so just call it again with the new `userId`:

```typescript
await registerPush({ topics, userId: newUserId });
```

## Pitfalls

- **`platform.push` is optional.** Always check `if (platform.push) { ... }` or use `platform.push!` only when you've gated the codepath behind a config check.
- **VAPID rotation breaks every subscription.** Don't rotate casually.
- **Service worker scope.** The SW must be served from a path that covers your registration page; `/sw.js` works for top-level registration.
- **iOS PWA quirks.** Web Push on iOS requires the user to install the PWA first (Add to Home Screen). Plan UI accordingly.
- **`tag` for de-dup.** Notifications sharing a `tag` replace each other in the OS shade; pick distinct tags for genuinely different messages.

## Related skills

- [maravilla-events](../maravilla-events/SKILL.md) — `onAuth`, `onSchedule`, `onDb` triggers that often kick off a push
- [maravilla-realtime](../maravilla-realtime/SKILL.md) — for delivery to **online** clients (don't push when SSE is enough)
- [maravilla-workflows](../maravilla-workflows/SKILL.md) — multi-step reminder pipelines

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
