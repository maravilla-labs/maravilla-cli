---
name: maravilla-workflows
description: "Maravilla Cloud durable workflows — replay-based, multi-step processes that survive restarts. Use whenever you need sleeps spanning minutes/hours/days, multi-step pipelines where each step's output feeds the next, waiting for external events, or strict step-history audit. `defineWorkflow` from `@maravilla-labs/functions/workflows/runtime` with `step.run`, `step.sleep`, `step.sleepUntil`, `step.waitForEvent`, `step.invoke`."
---

# Maravilla Workflows

Workflows are **durable, replay-based** functions. They run inside the runtime, persist every step's output to a ledger, and survive process restarts: on resume, the runtime replays the workflow function up to the last completed step, then continues from there.

This makes them ideal for:

- Multi-step processes where each step depends on the previous (`step.run` for at-most-once side effects)
- Long sleeps (`step.sleep('1h')`, `step.sleepUntil(date)`) — the function isn't running while it sleeps
- Waiting for an external event (`step.waitForEvent`)
- Composition (`step.invoke` to call a child workflow)

Workflows are unconditionally enabled — there's no opt-in flag. They have no HTTP trigger; you start them from your runtime code via `platform.workflows.start(...)`.

## Defining a workflow

Workflow files live in `workflows/*.ts` (auto-discovered by the framework adapter at build time). Use `defineWorkflow` from the runtime subpath:

```typescript
import { defineWorkflow } from '@maravilla-labs/functions/workflows/runtime';

interface Input { userId: string; reportId: string; }

export const buildReport = defineWorkflow<Input>(
  { id: 'build-report', options: { retries: 3, timeoutSecs: 60 * 60 } },
  async (input, step, ctx) => {
    const data = await step.run('fetch-data', async () => {
      return await fetchExpensiveData(input.userId);
    });

    const rendered = await step.run('render', async () => {
      return await renderPdf(data);
    });

    await step.run('upload', async () => {
      await ctx.platform.env.STORAGE.put(`reports/${input.reportId}.pdf`, rendered);
    });

    return { ok: true };
  },
);
```

> Import note for v0.2.5: `defineWorkflow` is exposed at `@maravilla-labs/functions/workflows/runtime`. The docs' `platform/workflows` subpath does **not** resolve in this release.

## Canonical example — the "click-watch" pattern

This is the demo's per-invitee click-watch workflow, lifted verbatim. One run per invitee escalates an unread-link warning twice over short windows, exits cleanly if the invitee record disappears, and emits live status via KV writes (which fire REN events for the owner's UI).

```typescript
/**
 * One durable workflow per invitee.
 *
 *   t=0                       start (snapshot + go to sleep)
 *   t=first-grace             check 1 — if not clicked, flag `unclicked_first` (amber chip)
 *   t=first-grace + second    check 2 — if still not clicked, flag `unclicked_final` (red chip)
 *
 * Each `ctx.kv.put` on `inv:{nanoid}` fires a REN event the owner's guest
 * list is already subscribed to, so chips appear live with no reload.
 */
import { defineWorkflow } from '@maravilla-labs/functions/workflows/runtime';

interface Input { inviteeNanoid: string; inviteId: string; ownerUserId: string; }

export const inviteeClickWatch = defineWorkflow<Input>(
  { id: 'invitee-click-watch', options: { retries: 3, timeoutSecs: 7 * 24 * 3600 } },
  async (input, step, ctx) => {
    const kv = ctx.kv as { get: any; put: any };
    const key = `inv:${input.inviteeNanoid}`;

    await step.sleep('first-grace', '60s');

    const firstOutcome = await step.run('check-1', async () => {
      const raw = await kv.get('invites', key);
      if (!raw) return 'removed' as const;
      const invitee = JSON.parse(raw);
      if (invitee.clicked_at) return 'clicked' as const;
      invitee.unclicked_first = true;
      await kv.put('invites', key, JSON.stringify(invitee));
      return 'unclicked' as const;
    });

    if (firstOutcome === 'removed') return { outcome: 'invitee-removed' };

    await step.sleep('second-grace', '120s');

    const secondOutcome = await step.run('check-2', async () => {
      const raw = await kv.get('invites', key);
      if (!raw) return 'removed' as const;
      const invitee = JSON.parse(raw);
      if (invitee.clicked_at) return 'clicked' as const;
      invitee.unclicked_final = true;
      await kv.put('invites', key, JSON.stringify(invitee));
      return 'unclicked' as const;
    });

    if (secondOutcome === 'removed') return { outcome: 'invitee-removed' };

    return { outcome: 'done', firstOutcome, secondOutcome };
  },
);
```

Two patterns to copy:

1. **Wrap every side effect in `step.run`.** Naked `await fetch(...)` or `await kv.put(...)` re-runs on replay. `step.run('name', ...)` is recorded in the ledger and skipped on replay if already completed.
2. **Exit cleanly on missing data.** Returning early when the watched record is gone makes the workflow safe against deletions; you don't need to remember to cancel each run.

## The `step` API

### `step.run(name, fn)` — at-most-once side effect

```typescript
const result = await step.run('charge-card', async () => {
  return await stripe.charges.create({ amount, source });
});
```

The first time this step runs, `fn` executes and its return value is persisted. On replay, the persisted value is returned without re-running `fn`. **Each step name within a workflow run must be unique.**

### `step.sleep(name, duration)` — short-form sleep

```typescript
await step.sleep('cool-down', '30s');
await step.sleep('grace', '24h');
```

Duration formats: `<n>s`, `<n>m`, `<n>h`, `<n>d`. The function unwinds while sleeping — your isolate isn't pinned for hours.

### `step.sleepUntil(name, date)` — sleep to a wall-clock target

```typescript
await step.sleepUntil('event-start', new Date(invite.event_date));
```

Pass a `Date` or ISO-8601 string.

### `step.waitForEvent(name, filter, options?)` — durable rendezvous

```typescript
const payment = await step.waitForEvent('payment-received', {
  type: 'payment.completed',
  match: { orderId: input.orderId },        // every key must equal in payload
}, { timeoutMs: 60 * 60 * 1000 });

if (!payment) {
  return { outcome: 'payment-timeout' };
}
```

Resolves when something else calls `platform.workflows.sendEvent('payment.completed', { orderId, ... })` and the `match` keys equal the payload's. Returns the payload, or `null` on timeout.

### `step.invoke(name, workflowId, input)` — child workflow

```typescript
const handle = await step.invoke('child', 'send-receipt', { orderId, email });
const result = await handle.result();
```

Composes workflows. The child's full step history is its own; the parent records only the invocation result.

## Starting and managing runs

Run starts come from your normal runtime code (route handlers, event handlers, other workflows) — there is **no HTTP trigger** for workflows.

```typescript
const platform = getPlatform();

// Start
const handle = await platform.workflows.start('build-report', { userId, reportId });
console.log(handle.runId);

// Get status (poll or surface in admin UI)
const run = await handle.status();
// { runId, workflowId, status: 'queued' | 'running' | 'sleeping' | 'waiting_event' | 'completed' | 'failed' | 'cancelled', ... }

// Step history (debugging)
const steps = await handle.history();

// Wait for completion
const output = await handle.result({ timeoutMs: 5 * 60_000 });

// Cancel
const cancelled = await handle.cancel();   // best-effort; returns true if it transitioned

// Get a handle to an existing run (no start)
const existing = platform.workflows.handle(savedRunId);
```

### Sending events to waiters

```typescript
// Anywhere in your runtime code:
const woken = await platform.workflows.sendEvent('payment.completed', {
  orderId: '123',
  amount: 4200,
});
// woken: number of runs resolved
```

Match rules: the `eventType` you pass must equal the waiter's filter `type`; every key in the waiter's `match` must be present in `payload` with an equal value.

## Patterns

### Lazy-start on first sight

If you can't always reach a "creation" point — e.g. the invitee row may already exist — start the workflow lazily on any save and let the workflow itself short-circuit if it's a duplicate:

```typescript
const handle = await platform.workflows.start('invitee-click-watch', {
  inviteeNanoid, inviteId, ownerUserId,
});
// Multiple starts → multiple runs; design the workflow to be safe on duplicates
// (e.g. include the nanoid in step names, or check a marker before flagging)
```

For strict deduplication, lookup by a stable key in KV:

```typescript
const existing = await kv.get('workflow-runs', `click-watch:${inviteeNanoid}`);
if (!existing) {
  const handle = await platform.workflows.start(/* ... */);
  await kv.put('workflow-runs', `click-watch:${inviteeNanoid}`, handle.runId);
}
```

### Saga / compensation

Each side effect lives in its own `step.run`. On failure, run compensating steps:

```typescript
try {
  const charge = await step.run('charge', () => stripe.charges.create(/* ... */));
  await step.run('reserve-inventory', () => inventory.reserve(items));
  await step.run('ship', () => shipping.create(/* ... */));
} catch (err) {
  await step.run('refund', () => stripe.refunds.create({ charge: charge.id }));
  throw err;
}
```

### Reminder pipeline

```typescript
await step.sleep('1h-warning', '1h');
await step.run('send-1h-warning', () => platform.push.send(target, /* ... */));

await step.sleep('5m-warning', '55m');
await step.run('send-5m-warning', () => platform.push.send(target, /* ... */));

await step.sleepUntil('event-time', input.event_date);
await step.run('event-started', () => /* ... */);
```

## Pitfalls

- **Naked side effects in the workflow body.** Anything outside `step.run` re-runs on every replay. Even `console.log` is fine, but `fetch`, `kv.put`, `db.insertOne` are not — wrap them.
- **Non-deterministic logic outside steps.** `Math.random()`, `Date.now()`, `crypto.randomUUID()` outside `step.run` will give different values on replay. Capture them inside a step.
- **Step name collisions.** The runtime keys steps by `name` per-run. Reusing a name in the same run is undefined behavior — append an iteration counter if you loop.
- **Long timeouts.** `options.timeoutSecs` is the **whole-run** budget. Make sure it covers worst-case sleeps + step durations.
- **Workflow vs event.** If you only need to react once and quickly, use an event handler (see [maravilla-events](../maravilla-events/SKILL.md)). Workflows pay a ledger cost per step.

## Related skills

- [maravilla-events](../maravilla-events/SKILL.md) — single-trigger handlers; often the entry point that starts a workflow
- [maravilla-realtime](../maravilla-realtime/SKILL.md) — `step.waitForEvent` rendezvous source
- [maravilla-push](../maravilla-push/SKILL.md) — typical workflow side effect (reminders)
- [maravilla-kv](../maravilla-kv/SKILL.md) — surfacing live workflow state to the UI

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
