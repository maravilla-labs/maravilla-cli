---
name: maravilla-storage
description: "Maravilla Cloud object storage — `platform.env.STORAGE` for files/images/videos. Presigned upload/download URLs for direct-from-browser transfer, capability-based access via unguessable keys, `getAssetUrl()` for `<img src>`, `confirm()` to fire `storage.put` events after presigned uploads, and `putStream` for chunked sources."
---

# Maravilla Storage

`platform.env.STORAGE` is an S3-shaped object store. Use it for anything bigger than a JSON blob: images, video, PDFs, user uploads, generated assets.

```typescript
import { getPlatform } from '@maravilla-labs/platform';
const storage = getPlatform().env.STORAGE;
```

Layer 1 (tenant isolation) is unconditional. If you've declared a `resource` with `name: 'storage'` (or matching your bucket convention) in `maravilla.config.ts`, Layer-2 policies gate every op.

## Direct ops

### `put(key, data, metadata?)`

```typescript
await storage.put('docs/report.pdf', pdfBytes, {
  contentType: 'application/pdf',
  uploadedBy: userId,
});
```

`data` accepts `Uint8Array` or `string`. Pass `metadata` for retrieval later.

### `putStream(key, source, metadata?)`

For sources you don't want to fully buffer in memory (large files, server-side generation):

```typescript
// Browser File / Blob
await storage.putStream('videos/clip.mp4', fileBlob, {
  contentType: fileBlob.type,
});

// Async iterable of chunks
async function* gen() {
  for await (const chunk of someAsyncSource) yield chunk;  // Uint8Array | string | ArrayBuffer | number[]
}
await storage.putStream('logs/large.txt', gen(), { contentType: 'text/plain' });
```

In the native runtime this streams without buffering. The remote dev client currently buffers as a fallback.

### `get(key)` → `Uint8Array | null`

```typescript
const bytes = await storage.get('docs/report.pdf');
if (bytes) return new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } });
```

### `getMetadata(key)` — without fetching bytes

```typescript
const meta = await storage.getMetadata('docs/report.pdf');
// { size, contentType?, lastModified, metadata? } | null
```

### `delete(key)`

```typescript
await storage.delete('docs/old-report.pdf');
```

### `list(options?)`

```typescript
const files = await storage.list({ prefix: 'uploads/', limit: 50 });
// files: Array<{ key, size, lastModified, metadata? }>
```

## Presigned URLs — direct-from-browser

The right pattern for user uploads. The browser PUTs straight to the storage backend; the bytes never touch your server.

### Generate an upload URL

```typescript
// In a server action / loader
const { url, method, headers, expiresIn } = await storage.generateUploadUrl(
  'uploads/document.pdf',
  'application/pdf',
  { sizeLimit: 10 * 1024 * 1024 },        // 10 MB
);

// Browser:
await fetch(url, { method, headers, body: fileBlob });

// Then notify the platform so storage.put events fire:
await storage.confirm('uploads/document.pdf');
```

### `confirm(key)` — required after presigned uploads

Because the bytes never crossed the server, no `storage.put` event would fire automatically. Call `confirm(key)` from your form action right after the client's PUT succeeds. The platform looks up the object's metadata and publishes the matching `storage.put` event so:

- Any `onStorage(...)` handler runs as if the upload had streamed through
- Any synthesized handlers from a `transforms` block in your config fire (resize / transcode / thumbnail)

`confirm` is **idempotent** — safe to call more than once with the same key. The server dedupes by `(tenant, key, mtime)`.

### Generate a download URL

```typescript
const { url, expiresIn } = await storage.generateDownloadUrl('uploads/document.pdf', {
  expiresIn: 7200,    // 2 hours, default 3600
});
return Response.json({ downloadUrl: url });
```

## `getAssetUrl(key, opts?)` — relative URL for `<img src>` / `<a href>`

```typescript
// Public asset — unsigned, cached for 24h
<img src={storage.getAssetUrl('public/logos/brand.png')} />

// Signed asset — HMAC + expiry
const docLink = storage.getAssetUrl('uploads/secret.pdf', { ttl: 60 });
```

Returns a relative `/_assets/<key>` URL served from the tenant's own hostname. **The URL never reveals workspace/project** — delivery resolves those from the host header.

The signed/unsigned heuristic:

- Keys starting with `public/` → unsigned + cached for 24h
- All other keys → signed by default (HMAC-bound `expires` + `sig` query string verified before serving)
- Override with `opts.signed: true | false`
- `opts.ttl` controls signed URL lifetime in seconds (default 3600)

## Capability-based access via unguessable keys

A common pattern: store a per-share-link record under an unguessable nanoid key, with `public: true`, while keeping the owner's master record at a private key:

```typescript
import { nanoid } from 'nanoid';

const inviteId = `inv_${nanoid()}`;
await db.insertOne('invites', { _id: inviteId, owner: user.id, public: true, ... });

// Photo lives at a key that mirrors the capability
await storage.putStream(`invites/${user.id}/${inviteId}/photo.png`, fileBlob, {
  contentType: 'image/png',
});

// Anyone with the link can view, no auth needed:
const photoUrl = storage.getAssetUrl(`public/invites/${inviteId}/photo.png`);
```

The combination of "unguessable id" + "policy that allows reads when `node.public == true`" gives you shareable links without exposing the owner's full inventory. See [maravilla-policies](../maravilla-policies/SKILL.md) for the policy side.

## Storage events + media transforms

`storage.put` and `storage.delete` events fire on every upload/delete (including after `confirm()` for presigned PUTs). Two ways to react:

### Hand-written handler

```typescript
// events/onPhotoUpload.ts
import { onStorage } from '@maravilla-labs/platform/events';

export const onPhotoUpload = onStorage(
  { keyPattern: 'uploads/photos/**', op: 'put' },
  async (event, ctx) => {
    const platform = ctx.platform as any;
    await platform.media.transforms.resize(event.key, {
      width: 1600, format: 'webp',
    });
  },
);
```

### Declarative transforms

If you only need to fan out a fixed set of `platform.media.transforms.*` calls per pattern, declare them in `maravilla.config.ts` and skip the handler file entirely:

```typescript
transforms: {
  'invites/*/*/videos/*': {
    transcode: [{ format: 'mp4' }],
    thumbnail: { at: '1s', width: 640, format: 'jpg' },
  },
  'invites/*/*/photo.*': {
    variants: [{ width: 400, format: 'webp', quality: 80 }],
  },
},
```

Each entry compiles into a synthesized `storage.put` handler with the calls fanned out via `Promise.all`.

## Patterns

### Server-side write, client-side read

```typescript
// Server: stream a generated PDF straight into storage
await storage.putStream(`reports/${reportId}.pdf`, generatePdfStream(data));

// Send the user a signed download URL
const { url } = await storage.generateDownloadUrl(`reports/${reportId}.pdf`,
  { expiresIn: 600 });
return { url };
```

### Client-side write, server-side process

```typescript
// 1. Server hands out a presigned upload URL
const presigned = await storage.generateUploadUrl(key, contentType, { sizeLimit });

// 2. Browser PUTs directly
await fetch(presigned.url, { method: presigned.method, headers: presigned.headers, body: file });

// 3. Server confirms → triggers events / transforms
await storage.confirm(key);
```

### Avatar / brand asset

```typescript
// Public — unsigned, cached
const logoUrl = storage.getAssetUrl('public/brand/logo.svg');

// Per-user avatar with short TTL signed URL
const avatarUrl = storage.getAssetUrl(`avatars/${userId}.jpg`, { ttl: 86400 });
```

## Pitfalls

- **Forgetting `confirm()` after a presigned upload.** Transforms / event handlers won't run; the synthesized `storage.put` event never fires.
- **`getAssetUrl` for a non-`public/` key without a logged-in user who can't reach the resource.** The signed URL still serves correctly because the HMAC is bound at issue time — but if your URL is being rendered server-side, make sure the server caller's policy permits reading the key.
- **Putting raw user input in keys.** Always normalize / hash / nanoid — both for security and because backend object stores have key-length limits.
- **`putStream` in the dev client.** It currently buffers as a fallback; in the native runtime it streams. Performance characteristics differ.

## Related skills

- [maravilla-events](../maravilla-events/SKILL.md) — `onStorage` handlers
- [maravilla-config](../maravilla-config/SKILL.md) — declarative `transforms`
- [maravilla-policies](../maravilla-policies/SKILL.md) — capability links via `node.public`

Full reference: <https://www.maravilla.cloud/llms-full.txt>.
