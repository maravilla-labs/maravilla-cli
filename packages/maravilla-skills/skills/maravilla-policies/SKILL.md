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

- **DB write** — the document being inserted/updated. `node.action`: `"write"` / `"delete"`.
- **DB read** — each candidate document from the result set (rows filtered post-policy if denied). `node.action`: `"read"`.
- **KV** — `{ namespace, key, action, value }` for per-key ops; `{ namespace, prefix, action }` for `list`. Actions: `"read"` (get), `"write"` (put — also carries `value_new`), `"delete"`, `"list"`.
- **Storage** — `{ bucket, key, action }` for per-key ops; `{ bucket, prefix, action }` for `list`. Actions: `"get"`, `"put"`, `"delete"`, `"list"`, `"upload-url"`, `"download-url"`, `"get-metadata"`, `"confirm"`. **NOT** `"read"`/`"write"` — those are KV's. Mixing them is a silent denial: `node.action == "read"` on a storage op never matches because the actual action is `"get"`.

#### Action-string contract

| Resource type | Per-key actions | List action | Other |
|---|---|---|---|
| KV (`type: 'kv'`) | `read`, `write`, `delete` | `list` | — |
| DB (`type: 'database'`) | `read`, `write`, `delete` | (uses `read` per-row) | — |
| Storage (`type: 'storage'`) | `get`, `put`, `delete`, `get-metadata`, `confirm` | `list` | `upload-url`, `download-url` |
| Realtime (`type: 'realtime'`) | `subscribe`, `publish` | — | — |

Source of truth: `crates/runtime/src/ops/platform/{ops_kv,ops_db,ops_storage,ops_realtime}.rs`.

#### `node.value` (existing) vs `node.value_new` (incoming)

For KV `write` ops (`platform.env.KV.<ns>.put(key, value)`), the runtime gives the policy **both** field shapes:

| Field | When present | What it contains |
|---|---|---|
| `node.value_new` | Always on `write` | The incoming payload — what JS just passed to `put` |
| `node.value` | On `write`, `read`, `delete` if a policy is attached to the resource | The pre-existing record at this key, or `null` on first-write |

This split matters when your data has a "owner" field embedded in the value (not in the key). For a "partners can write their own deals only" rule, you need to check **both**:

1. The new value's owner is the caller (`node.value_new.partner_userId == auth.user_id`) — otherwise they'd be writing someone else's deal.
2. If a record already exists, its owner is also the caller (`node.value == null || node.value.partner_userId == auth.user_id`) — otherwise a malicious caller could rewrite an existing deal's `partner_userId` to grab it.

```ts
// Worked example — gating writes on a value-side owner field
'(node.action == "write" && auth.user_id != "" && node.key.startsWith("deal:") '
+ '  && node.value_new.partner_userId == auth.user_id '
+ '  && (node.value == null || node.value.partner_userId == auth.user_id))'
```

The `node.value == null || …` guard handles first-writes (where there's nothing to check against) without weakening the take-over protection. Read/delete ops only carry `node.value` — gate them on that alone.

Storage `write` (`put`) also carries `node.value` (existing object metadata) but **does not** populate `node.value_new` — the bytes aren't deserialised into JSON. For storage, ownership must come from the key shape.

#### Don't `JSON.stringify` values your policy reads

The runtime stores whatever JS passes to `KV.put` **verbatim** (`crates/runtime/src/ops/platform/ops_kv.rs::op_kv_put` — serde-deserialises into `JsonValue`). So:

| What JS does | What the policy sees as `node.value_new` | Field access works? |
|---|---|---|
| `KV.put(k, JSON.stringify(obj))` | `JsonValue::String("{...}")` — a string | **No.** `node.value_new.foo` → `null` for any field |
| `KV.put(k, obj)` | `JsonValue::Object(map)` — a real object | Yes |

If your policy uses `node.value_new.<field>` (or `node.value.<field>` on update/delete), the value **must be an object** on the way in. The hello-world `put(k, JSON.stringify(x))` pattern still works for key-only policies, but breaks silently the moment you reach for a field on the value:

```ts
// BUG — value_new arrives as a string, partner_userId resolves to null,
// the policy denies, the user gets a 500.
await KV.put(`deal:${deal.id}`, JSON.stringify(deal));

// FIX — pass the object; the runtime serialises it for you.
await KV.put(`deal:${deal.id}`, deal);
```

Reads still work either way if your `parse()` helper accepts both shapes (`typeof raw === 'object' ? raw : JSON.parse(raw)`), so you can roll this fix forward without a migration.

This trap is invisible at type-check time — `KV.put` accepts `unknown` for value — and the failure mode is "policy denies on a payload that looks correct in the logs." If you see policy denials with a value-side check that should pass, log `typeof` of what you passed before suspecting the policy.

#### `node.key` shape gotcha (storage only)

For storage ops, `node.key` is the **full** key your JS code passed to `STORAGE.get/put/etc.` — including any leading "bucket"/resource-name segment your SDK helpers prepend. The runtime extracts `bucket = key.split_once('/').0` for resource_name lookup but does NOT strip it from `node.key` before policy eval.

So if your `storage.server.ts` (or equivalent) prepends the resource name like `partner-files/`, your `startsWith()` clauses must include it too:

```ts
// WRONG — never matches; storage.get sends partner-files/templates/...
'node.key.startsWith("templates/")'

// RIGHT
'node.key.startsWith("partner-files/templates/")'
```

KV `node.key` does NOT include the namespace — KV ops pass the user's key verbatim. Only storage has this gotcha because of the bucket-derived resource_name pattern.

## Scoping bulk reads with `read_filter`

The expressions above are **per-record predicates** — the runtime evaluates them against a single record (`findOne`, a single-key `get`, each write). For `find` / `list` that return many rows, declare a **`read_filter`** on the resource (in `maravilla.config.ts`): a JSON query filter the runtime ANDs into the query *before it runs*, so callers only ever read their own rows.

```typescript
// maravilla.config.ts
{
  name: 'reviews',
  type: 'database',
  actions: ['read', 'write', 'delete'],
  policy: 'auth.user_id == node.owner || auth.is_admin',   // per-record: findOne + writes
  read_filter: '{"owner":"$auth.user_id"}',                // bulk reads: find / list
}
```

- It's a normal query object over the resource's own fields — ANDed into whatever filter the caller passed. `$auth.*` placeholders are substituted from the bound caller at request time: `$auth.user_id`, `$auth.email`, `$auth.is_admin`, `$auth.groups`, `$auth.roles`, `$auth.profile.<field>`.
- Compose with `$or` for "mine plus shared": `'{"$or":[{"owner":"$auth.user_id"},{"public":true}]}'`.
- `policy` and `read_filter` are complementary: `policy` makes single-record access decisions; `read_filter` scopes the rows a list returns. Apps that mix per-user and shared data usually want both.

Declared in config, applied with the rest of your auth settings ([maravilla-config](../maravilla-config/SKILL.md) → applying config, or the Auth Settings → Resources UI).

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

### Storage: per-user files + shared templates

```javascript
// Resource declaration in maravilla.config.ts:
{
  name: 'app-files',
  type: 'storage',
  actions: ['read', 'write', 'delete', 'list'],  // declarative; runtime uses get/put/delete/list internally
  policy:
    'auth.groups.contains("admin") || ' +
    // Owner unrestricted on their own subtree:
    '(auth.user_id != "" && node.key.startsWith("app-files/users/" + auth.user_id + "/")) || ' +
    // Every authenticated user reads shared templates (get / get-metadata / download-url):
    '((node.action == "get" || node.action == "get-metadata" || node.action == "download-url") '
    + ' && auth.user_id != "" && node.key.startsWith("app-files/templates/")) || ' +
    // List the templates prefix (list ops carry node.prefix not node.key):
    '(node.action == "list" && auth.user_id != "" && node.prefix.startsWith("app-files/templates/")) || ' +
    // Owner lists their own subtree:
    '(node.action == "list" && auth.user_id != "" && node.prefix.startsWith("app-files/users/" + auth.user_id))',
}
```

Three things to internalise from this example:

1. **List vs get clauses are separate.** `list` ops carry `node.prefix` (a directory-style prefix). All other ops carry `node.key` (the full key). A clause that uses `node.key` will never match for `list`, and vice versa.
2. **Action enumeration for "read-like" storage ops.** There's no single `"read"` — pick the actions your app actually uses. `get` covers `STORAGE.get`; `get-metadata` for `getMetadata`; `download-url` for `generateDownloadUrl`. List them explicitly.
3. **Resource-name prefix on every storage `startsWith()`.** See the gotcha above.

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
