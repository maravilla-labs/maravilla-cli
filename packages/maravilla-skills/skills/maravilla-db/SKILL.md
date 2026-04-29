---
name: maravilla-db
description: "Maravilla Cloud document database — MongoDB-style queries, secondary indexes, and vector search. Use for structured app data, multi-field queries, sorting, semantic search via `findSimilar` / hybrid `find` with `options.vector`. Exposed as `platform.env.DB`. Vector indexes support int8/bit quantization, matryoshka, and multi-vector (ColBERT) out of the box."
---

# Maravilla DB

`platform.env.DB` is a MongoDB-shaped document store with secondary indexes and first-class vector search. Two backends: a Mongo-mode default and a per-tenant SQLite mode (set via the `production-sqlite` feature flag — vector search runs there).

```typescript
import { getPlatform } from '@maravilla-labs/platform';
const db = getPlatform().env.DB;
```

Layer 1 (tenant isolation) is unconditional. If you've declared a `resource` in `maravilla.config.ts` whose `name` matches the collection name, Layer-2 policies gate every op too — including `find`, where rows that fail the policy are silently filtered out of the result set. See [maravilla-policies](../maravilla-policies/SKILL.md).

## CRUD basics

### Insert

```typescript
const id = await db.insertOne('users', {
  name: 'Alex',
  email: 'alex@example.com',
  createdAt: Date.now(),
  active: true,
});
// id is the auto-assigned _id (string)
```

### Find

```typescript
// All matching docs
const active = await db.find('users', { active: true });

// With pagination + sort
const recent = await db.find('posts',
  { published: true },
  { limit: 10, sort: { createdAt: -1 }, skip: 0 },
);

// Single doc
const me = await db.findOne('users', { email: 'alex@example.com' });
```

Filter operators supported: `$eq` (default), `$ne`, `$gt` / `$gte` / `$lt` / `$lte`, `$in` / `$nin`, `$exists`, `$and`, `$or`. Not supported: `$regex`, `$where`, `$text`.

### Update

```typescript
const result = await db.updateOne('users',
  { email: 'alex@example.com' },
  {
    $set: { lastLogin: Date.now() },
    $inc: { loginCount: 1 },
    $push: { ipHistory: '1.2.3.4' },
  },
);
// result.modified — number of docs modified
```

Update operators: `$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet`. Field paths support dotted notation.

### Delete

```typescript
const { deleted } = await db.deleteOne('posts', { _id: postId });
const { deleted: many } = await db.deleteMany('users', { active: false });
```

## Indexes — declarative + imperative

The recommended path is to declare indexes in `maravilla.config.ts` so they're versioned with your code and reconciled on deploy. See [maravilla-config](../maravilla-config/SKILL.md).

```typescript
// maravilla.config.ts
database: {
  indexes: [
    { collection: 'users', keys: [['email', 1]], unique: true },
    { collection: 'posts', keys: [['authorId', 1], ['createdAt', -1]] },
    { collection: 'sessions',
      keys: [['createdAt', 1]],
      expireAfterSeconds: 3600 },
  ],
},
```

You can also create indexes imperatively at runtime:

```typescript
await db.createIndex('users', { keys: { email: 1 }, unique: true });
await db.createIndex('posts', { keys: [['authorId', 1], ['createdAt', -1]] });
await db.createIndex('sessions', { keys: { createdAt: 1 }, expireAfterSeconds: 3600 });

// Drop
await db.dropIndex('users', 'email_1');

// Inspect
const all = await db.listIndexes('users');   // includes both document and vector indexes
```

`IndexSpec` options:

- `keys` — `Array<[field, 1 | -1]>` (preferred) or `Record<field, 1 | -1>`
- `unique` — enforce uniqueness across the indexed columns
- `sparse` — shorthand for `partial: { <field>: { $exists: true } }`
- `partial` — predicate using inline-literal operators only (no `$regex`)
- `expireAfterSeconds` — TTL on a single-field index over a unix-seconds field

Use **tuple form** for compound keys — JS object key order is not guaranteed across runtimes.

## Vector search — first-class, with quantization

Vector indexes are real first-class citizens, not a roadmap item. The v1 surface includes int8 and 1-bit quantization, matryoshka (truncated query vectors), and multi-vector / late-interaction (ColBERT-style).

### Register a vector index

```typescript
// Declarative (preferred)
database: {
  vectorIndexes: [
    { collection: 'products', field: 'embedding',
      dimensions: 1536, metric: 'cosine', storage: 'int8' },
  ],
},

// Imperative
await db.createVectorIndex('products', {
  field: 'embedding',
  dimensions: 1536,
  metric: 'cosine',     // 'cosine' | 'l2' | 'hamming'
  storage: 'int8',      // 'float32' (default, 4B/dim)
                        // 'int8'  (1B/dim, ~4× smaller, <2% accuracy loss)
                        // 'bit'   (1bit/dim, 32× smaller; requires metric='hamming')
  matryoshka: false,    // allow query vectors shorter than `dimensions` (req. matryoshka-trained embeddings)
  multiVector: false,   // each doc holds an array of vectors (chunk/token level)
});
```

Inserts thereafter automatically sync the value at `field` into the ANN-indexed table inside the same SQLite transaction as the document write — your inserts stay atomic.

### Pure vector search

```typescript
const hits = await db.findSimilar('products', {
  field: 'embedding',
  value: queryEmbedding,            // number[] for single-vector
  k: 10,
  metric: 'cosine',                 // optional override
  minScore: 0.7,                    // drop hits below this normalized score
  filter: { category: 'shoes' },    // optional metadata filter
  limit: 10,
});
// hits: VectorSearchHit[] — your doc fields plus _score and _distance
```

### Hybrid metadata + vector via `find`

```typescript
const hits = await db.find('products',
  { category: 'shoes', stock: { $gt: 0 } },   // metadata filter
  {
    limit: 20,
    vector: {
      field: 'embedding',
      value: queryEmbedding,
      k: 50,
      minScore: 0.6,
    },
  },
);
```

The metadata filter is applied alongside (or after, depending on the index type) the vector ranking.

### Multi-vector / late interaction

```typescript
await db.createVectorIndex('passages', {
  field: 'token_embeddings',
  dimensions: 128,
  metric: 'cosine',
  multiVector: true,
});

const hits = await db.findSimilar('passages', {
  field: 'token_embeddings',
  value: queryTokenEmbeddings,    // number[][] — one vector per query token
  k: 10,
  queryMode: 'late-interaction',
  aggregation: 'max-sim',         // 'max-sim' (default) or 'sum'
});
```

### Listing & dropping vector indexes

```typescript
const vIxs = await db.listVectorIndexes('products');
await db.dropVectorIndex('products', 'embedding');
// { removed: true } if it existed
```

`listIndexes(collection)` returns both regular and vector indexes in a unified shape (`kind: 'document' | 'vector'`).

## Query patterns

### "Get my stuff"

Combine the auth contract with a filter:

```typescript
// Inside a route, after hooks.server.ts ran setCurrentUser(token):
const me = platform.auth.getCurrentUser();
const myPosts = await db.find('posts',
  { ownerId: me.user_id },
  { sort: { createdAt: -1 }, limit: 50 },
);
```

If your `posts` resource has policy `auth.user_id == node.ownerId || auth.is_admin`, you don't even need the explicit filter — the policy filters the result set for you.

### Pagination

Use cursor-style on a stable sort key plus `_id`:

```typescript
const page = await db.find('posts',
  { ...filter, ...(cursor ? { createdAt: { $lt: cursor } } : {}) },
  { sort: { createdAt: -1 }, limit: 20 },
);
const nextCursor = page.length === 20 ? page.at(-1)!.createdAt : null;
```

### Atomic counters

```typescript
await db.updateOne('users', { _id: userId }, { $inc: { visits: 1 } });
```

Single-document updates are atomic. Cross-document atomicity requires a workflow — see [maravilla-workflows](../maravilla-workflows/SKILL.md).

### TTL'd documents

```typescript
// In maravilla.config.ts
{ collection: 'sessions', keys: [['createdAt', 1]], expireAfterSeconds: 3600 }
```

A background sweeper deletes documents whose indexed unix-seconds field is older than `expireAfterSeconds`.

## Pitfalls

- **Empty results despite valid data?** Almost always a missed `setCurrentUser(token)` in your hook — the policy denies because `auth.user_id` is empty. See [maravilla-auth](../maravilla-auth/SKILL.md).
- **`find` returns a subset of expected docs.** Layer-2 silently filters denied rows. Use `platform.policy.setEnabled(false)` in a known-safe block to confirm whether the policy is the cause.
- **Compound indexes from object literals.** Prefer `[['a', 1], ['b', -1]]` tuples — object key order is implementation-dependent.
- **Vector index storage mismatch.** `storage: 'bit'` requires `metric: 'hamming'`. Mixing them errors out at index creation.

## Related skills

- [maravilla-config](../maravilla-config/SKILL.md) — declarative index management
- [maravilla-policies](../maravilla-policies/SKILL.md) — gate per-collection ops
- [maravilla-events](../maravilla-events/SKILL.md) — `onDb({ collection, op })` handlers for derived state
- [maravilla-kv](../maravilla-kv/SKILL.md) — when to prefer KV over DB

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
