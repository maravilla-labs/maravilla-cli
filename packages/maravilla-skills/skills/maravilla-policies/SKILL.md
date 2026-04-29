---
name: maravilla-policies
description: "Maravilla Layer-2 resource policies — the raisin-rel expression language with `auth.*` and `node.*`. Use when writing or debugging `policy` strings in `maravilla.config.ts`, when an authenticated user sees an empty list (likely policy denial), or when reasoning about groups, relations, and per-action rules."
---

# Maravilla Policies (Layer 2)

Maravilla enforces authorization in two layers:

- **Layer 1 — tenant + owner isolation.** Always on. Cannot be disabled. A request can never see another tenant's data.
- **Layer 2 — per-resource policies.** Declarative expressions you write in `maravilla.config.ts`. Evaluated on every KV / DB / realtime / media op against that resource. Configurable per-resource and toggleable per-request.

This skill is the reference for the Layer-2 expression language. For where policies are declared, see [maravilla-config](../maravilla-config/SKILL.md).

## Where policies live

```typescript
// maravilla.config.ts
export default defineConfig({
  auth: {
    resources: [
      {
        name: 'invites',
        title: 'Birthday Invites',
        actions: ['read', 'write', 'delete'],
        policy: 'auth.user_id == node.owner || auth.is_admin || node.public == true',
      },
    ],
  },
});
```

`name` is the resource key — for KV that's the namespace, for DB that's the collection name, for storage it's the bucket. The runtime maps every op to a resource and runs that resource's `policy` string.

Resources **without** a policy skip Layer-2 entirely (Layer 1 still applies). Resources **with** a policy must have their expression evaluate truthy or the op fails.

## The two scopes: `auth.*` and `node.*`

Every policy sees exactly two top-level objects.

### `auth.*` — the bound caller

This is whatever `platform.auth.getCurrentUser()` would return for this request:

| Field | Type | Notes |
|---|---|---|
| `auth.user_id` | string | `""` when anonymous |
| `auth.email` | string | `""` when anonymous |
| `auth.is_admin` | boolean | Admin flag from session |
| `auth.roles` | string[] | Project-scoped role names |
| `auth.is_anonymous` | boolean | `true` if no identity bound |

**Reminder:** for `auth.user_id` to be non-empty you must run the [3-step contract](../maravilla-auth/SKILL.md): `validate(token)` → `setCurrentUser(token)` → op. Skipping `setCurrentUser` is the root cause of "logged-in but seeing empty data" bugs.

### `node.*` — the resource payload for this op

Shape depends on the op:

- **DB write** — the document being inserted/updated.
- **DB read** — each candidate document from the result set (rows are filtered post-policy if denied).
- **KV put** — `{ key, value, namespace }`.
- **KV get** — `{ key, namespace, ...value-fields-if-known }`.
- **Storage put / get** — `{ key, contentType, size }`.
- All ops carry `node.action` — `"read" | "write" | "delete"` — so you can branch per-action in a single expression.

## Common patterns

### Owner-only

```javascript
'auth.user_id == node.owner || auth.is_admin'
```

The classic. Every doc has an `owner` field set to a user id; the owner and admins can do anything.

### Owner with a public escape hatch

```javascript
'auth.user_id == node.owner || auth.is_admin || node.public == true'
```

Used by capability-link sharing — the owner stores some records under unguessable ids (e.g. `inv:{nanoid}`) with `public: true`, so anyone with the link can read but the owner's full list stays private.

### Per-action branches

```javascript
'(node.action == "read" && node.status == "published" && node.visibility == "public") '
+ '|| auth.roles.contains("teacher") '
+ '|| auth.is_admin'
```

Reads are public when published-and-public; teachers and admins do anything.

### Authenticated-only writes, anyone-reads

```javascript
'node.action == "read" '
+ '|| (node.action == "write" && auth.user_id != "") '
+ '|| (node.action == "delete" && (auth.user_id == node.author_id || auth.is_admin))'
```

Comment-board pattern: anyone reads, any signed-in user can write, only the author or an admin can delete.

### Membership in a group

```javascript
'auth.is_admin || auth.user RELATES "g_coordinators" VIA "MEMBER_OF"'
```

Resolves at evaluation time against the user-group-membership table.

### Stewardship via a custom relation

Given `relations: [{ relation_name: 'STEWARDS', implies_stewardship: true }]` in your config:

```javascript
'auth.user_id == node.owner '
+ '|| auth.user RELATES node.owner VIA "STEWARDS" '
+ '|| auth.is_admin'
```

Lets a steward (e.g. a parent) act on a minor's records.

### Self-only with a guarded write source

```javascript
'auth.user_id == node.user_id && node.source == "self" '
+ '|| auth.is_admin'
```

Used in self-enroll endpoints where the doc must be tagged `source: "self"` — admin-assigned variants are blocked from this writer and handled by a separate path.

### Read-only collection (audit logs)

```javascript
'auth.is_admin'
```

Only admins can read or write the `admin_audit` collection.

## Operators and built-ins

- Comparison: `==`, `!=`, `<`, `<=`, `>`, `>=`
- Logical: `&&`, `||`, `!`
- Membership: `auth.roles.contains("teacher")`, `node.tags.contains("featured")`
- Existence: `auth.user_id != ""` for "is signed in"
- Relations: `auth.user RELATES <target> VIA "<RELATION_NAME>"` — relation name must match a `RelationTypeDefinition.relation_name` in your config

The expression language is intentionally narrow — if you need wall-clock checks or external lookups, do it in your handler before the op (or use [`platform.auth.can()`](../maravilla-auth/SKILL.md) to test ahead of time).

## Per-request opt-out (admin paths only)

For trusted in-app flows — first-run seeders, admin batch jobs — you can disable Layer 2 for the remainder of the current request:

```typescript
const platform = getPlatform();
platform.policy.setEnabled(false);   // Layer 1 still applies
try {
  await runSeeder();
} finally {
  platform.policy.setEnabled(true);
}
```

Every flip is **audit-logged server-side** with the caller's identity. Do not branch on untrusted input — only on stable conditions like `caller.is_admin`.

## Pre-checking with `can()`

Before running a UI action, ask the policy engine:

```typescript
const ok = await platform.auth.can('delete', 'documents', {
  owner: doc.owner,
  status: doc.status,
});
if (!ok) return new Response('Forbidden', { status: 403 });
```

The `can()` evaluator is the same engine that gates direct ops, so its answer is authoritative.

## Debugging "logged in but empty list"

Symptoms: cookie is present, `event.locals.user` is set, but `find()` returns 0 rows.

Almost always caused by skipping `setCurrentUser(token)` in your hook. The 3-step contract is non-negotiable; see [maravilla-auth](../maravilla-auth/SKILL.md). Quick checklist:

1. Is `platform.auth.setCurrentUser(token)` called in your `hooks.server.ts` (or RR7 / Nitro equivalent) right after `validate(token)`?
2. Inside the loader, log `platform.auth.getCurrentUser()` — does it show the right `user_id`, or `""`?
3. If `user_id` is set but reads still return empty, the policy is denying — log `await platform.auth.can('read', '<resource>', sample_node)` to see what's blocking.

## Related skills

- [maravilla-config](../maravilla-config/SKILL.md) — where to declare resources, groups, relations
- [maravilla-auth](../maravilla-auth/SKILL.md) — the 3-step request binding
- [maravilla-db](../maravilla-db/SKILL.md), [maravilla-kv](../maravilla-kv/SKILL.md), [maravilla-storage](../maravilla-storage/SKILL.md) — the ops gated by policies

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
