---
name: maravilla-config
description: "The `maravilla.config.ts` declarative project file. Use whenever creating or modifying auth resources, groups, relations, registration fields, OAuth providers, password/session policy, branding, database indexes, or media transforms. Reconciled into delivery on every deploy — partial adoption is supported (omit a section to leave it untouched)."
---

# Maravilla Cloud — `maravilla.config.ts`

`maravilla.config.ts` lives at your project root and declares everything project-scoped: resources + policies, named groups, relation types, registration fields, OAuth providers, security/branding settings, database indexes, and media transforms.

The build-time adapter reads this file, the runtime ships it as part of the manifest, and the platform reconciles the settings on each deploy. Sections are **upsert-only** for list-shaped data (resources, groups, relations, oauth, indexes) — declaring them creates/updates entries but never auto-deletes DB-only ones. Singleton sections (`registration`, `security`, `branding`) are replaced wholesale when declared.

## Skeleton

```typescript
import { defineConfig } from '@maravilla-labs/platform/config';

export default defineConfig({
  auth: {
    resources: [/* ... */],
    groups: [/* ... */],
    relations: [/* ... */],
    registration: { fields: [/* ... */] },
    oauth: { /* ... */ },
    security: { /* ... */ },
    branding: { /* ... */ },
  },
  database: {
    indexes: [/* ... */],
    vectorIndexes: [/* ... */],
  },
  transforms: { /* ... */ },
});
```

`defineConfig` is an identity function — it exists purely so TypeScript can infer the shape and give you full IntelliSense.

## `auth.resources` — Layer-2 policy gates

Each resource names a subsystem (a KV namespace, a DB collection, a media bucket) plus the actions it supports and a single policy expression.

```typescript
resources: [
  // No policy → only Layer 1 (tenant isolation) applies. Useful for
  // anonymous-friendly demos.
  {
    name: 'todos',
    title: 'Todos',
    description: 'Shared todo items (anonymous-friendly)',
    actions: ['read', 'write', 'delete'],
  },
  // Owner-scoped, with a public-share escape hatch via an unguessable id.
  {
    name: 'invites',
    title: 'Birthday Invites',
    actions: ['read', 'write', 'delete'],
    policy: 'auth.user_id == node.owner || auth.is_admin || node.public == true',
  },
  // Plain owner-or-admin.
  {
    name: 'vcards',
    title: 'Digital Business Cards',
    actions: ['read', 'write', 'delete'],
    policy: 'auth.user_id == node.owner || auth.is_admin',
  },
],
```

The policy expression is the **raisin-rel** language; full details live in [maravilla-policies](../maravilla-policies/SKILL.md). Key points:

- `auth.*` is the bound caller — `auth.user_id`, `auth.email`, `auth.is_admin`, `auth.roles`, `auth.is_anonymous`.
- `node.*` is the resource-shaped data for the specific op being checked.
- `node.action` is the action being performed (read / write / delete) — useful for action-specific clauses.
- Leaving `policy` empty disables Layer-2 for that resource. Layer 1 still applies.

## `auth.groups` — named permission bundles

```typescript
groups: [
  {
    name: 'coordinators',
    description: 'Can manage gatherings across the whole tenant',
    permissions: [
      { resource_name: 'gatherings', actions: ['read', 'write'] },
    ],
  },
],
```

Group **definitions** live in config; **membership** (which users belong to which group) is runtime data managed via the admin UI or `platform.auth.updateUser()`.

## `auth.relations` — typed user-to-user edges

For relationship-aware policies (e.g. "stewards can act on behalf of minors"):

```typescript
relations: [
  {
    relation_name: 'STEWARDS',     // uppercase identifier used in policies
    title: 'Stewards',
    category: 'family',
    implies_stewardship: true,
    bidirectional: false,
  },
],
```

Reference in policies as `auth.user RELATES node.owner VIA 'STEWARDS'`.

## `auth.registration.fields` — custom signup form

Replaces the registration form's whole field list when declared.

```typescript
registration: {
  fields: [
    { key: 'email',        label: 'Email',        field_type: 'email', required: true,  show_on_register: true },
    { key: 'display_name', label: 'Display name', field_type: 'text',  required: true,  show_on_register: true },
    { key: 'company',      label: 'Company',      field_type: 'text',  required: false, show_on_register: true },
  ],
},
```

`field_type` is one of: `text`, `email`, `phone`, `date`, `number`, `select`, `boolean`, `url`, `textarea`. Custom fields land on the `AuthUser`'s profile and on `event.data.profile` in any `onAuth({ op: 'registered' })` handler.

## `auth.oauth` — third-party identity providers

```typescript
oauth: {
  google: {
    enabled: true,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: { env: 'GOOGLE_CLIENT_SECRET' },  // resolved server-side
    scopes: ['openid', 'email', 'profile'],
  },
  github: {
    enabled: true,
    client_id: process.env.GITHUB_CLIENT_ID!,
    client_secret: { env: 'GITHUB_CLIENT_SECRET' },
    scopes: ['read:user', 'user:email'],
  },
},
```

Supported providers: `google`, `github`, `okta`, `custom_oidc` (set `discovery_url` on the last). Secrets accept either `"literal"`, `"${env.NAME}"` template form, or `{ env: "NAME" }` object form — only references are safe to commit.

A common build-time pattern is to omit a provider entirely when its env var is missing, rather than declaring `enabled: false`:

```typescript
function buildOAuth() {
  const o: Record<string, unknown> = {};
  if (process.env.GOOGLE_CLIENT_ID) {
    o.google = { enabled: true, client_id: process.env.GOOGLE_CLIENT_ID,
                 client_secret: { env: 'GOOGLE_CLIENT_SECRET' },
                 scopes: ['openid', 'email', 'profile'] };
  }
  return o;
}
```

## `auth.security` — passwords + sessions

```typescript
security: {
  password_policy: {
    min_length: 12,
    require_uppercase: true,
    require_number: true,
    require_special: false,
  },
  session: {
    access_token_ttl_secs: 900,        // 15 min
    refresh_token_ttl_secs: 2_592_000, // 30 days
    max_sessions_per_user: 5,
    require_email_verification: true,
  },
},
```

Disable `require_email_verification` while you're still wiring email delivery — flip it on once SMTP/Mailgun is healthy.

## `auth.branding` — hosted auth pages

```typescript
branding: {
  app_name: 'My App',
  logo_url: '/_assets/logo.png',
  primary_color: '#3b82f6',
  layout: 'centered',                  // "centered" | "split-left" | "split-right" | "fullscreen"
  color_mode: 'auto',                  // "light" | "dark" | "auto"
  welcome_message: 'Welcome back',
  terms_url: '/terms',
  privacy_url: '/privacy',
  custom_css: '.btn-primary { border-radius: 999px; }',
},
```

Applied to the hosted `/_auth/login`, `/_auth/register`, OAuth callback, and password reset pages.

## `database.indexes` — Mongo-style secondary indexes

Reconciled upsert-only. Speeds up `find()` / `findOne()` on the indexed fields.

```typescript
database: {
  indexes: [
    // Unique single-field
    { collection: 'lessons', keys: [['slug', 1]], unique: true },
    // Compound
    { collection: 'modules', keys: [['course_id', 1], ['order', 1]] },
    // Sparse — allows multiple docs to omit the field
    { collection: 'enrollments',
      keys: [['user_id', 1], ['course_id', 1]],
      unique: true, sparse: true },
    // TTL — deletes docs older than expireAfterSeconds (single-field index on a unix-seconds field)
    { collection: 'sessions',
      keys: [['created_at', 1]],
      expireAfterSeconds: 3600 },
  ],
},
```

Use **tuple form** `[['field', 1]]` for compound indexes — object key order is language-dependent and breaks the ordering invariant.

## `database.vectorIndexes` — semantic search

```typescript
vectorIndexes: [
  {
    collection: 'products',
    field: 'embedding',
    dimensions: 1536,
    metric: 'cosine',          // 'cosine' | 'l2' | 'hamming'
    storage: 'int8',           // 'float32' (default) | 'int8' | 'bit'
    matryoshka: false,         // allow short query vectors
    multiVector: false,        // ColBERT-style late interaction
  },
],
```

See [maravilla-db](../maravilla-db/SKILL.md) for the query side (`findSimilar`, hybrid `find` with `options.vector`).

## `transforms` — declarative media pipelines

Each entry compiles into a synthesized `storage.put` event handler that fans out a `Promise.all` of the declared `platform.media.transforms.*` calls every time a matching upload lands. No hand-written event file needed.

```typescript
transforms: {
  // Glob keyed → transform list
  'invites/*/*/videos/*': {
    transcode: [{ format: 'mp4' }],
    thumbnail: { at: '1s', width: 640, format: 'jpg' },
  },
  'invites/*/*/photo.*': {
    variants: [{ width: 400, format: 'webp', quality: 80 }],
  },
},
```

If you need branching logic, fall back to a hand-written `events/onSomeUpload.ts` with `onStorage(...)` — see [maravilla-events](../maravilla-events/SKILL.md).

## Partial adoption

You only declare what you want managed. Empty/omitted sections leave the DB alone — useful for incremental rollout:

```typescript
// Phase 1 — just policies
export default defineConfig({
  auth: { resources: [{ name: 'todos', title: 'Todos', actions: ['read', 'write'] }] },
});

// Phase 2 — add indexes alongside
export default defineConfig({
  auth: { resources: [/* ... */] },
  database: { indexes: [/* ... */] },
});
```

## Related skills

- [maravilla-policies](../maravilla-policies/SKILL.md) — the policy expression language
- [maravilla-auth](../maravilla-auth/SKILL.md) — the request-scoped binding contract
- [maravilla-db](../maravilla-db/SKILL.md) — index usage and vector queries
- [maravilla-events](../maravilla-events/SKILL.md) — hand-written `onStorage` for transforms with branching

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
