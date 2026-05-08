---
name: maravilla-media-transforms
description: "Async media + document derivations via `platform.media.transforms` and the declarative `transforms` block in `maravilla.config.ts`. Media: transcode video, thumbnail extraction, image resize/variants, OCR. Documents (.docx/.odt/.pptx/.xlsx/...): convert to PDF, render page thumbnails, generic format conversion, Markdown extraction (RAG-ready), single-file HTML with inlined images, image-replacement templating ({{TAG}} swap + named-object swap), QR-code injection. Use when ingesting user uploads that need normalised renditions, generating contracts/invoices from templates, or extracting structured content for LLMs. Critical: derived keys are content-addressed — `keyFor(srcKey, spec)` is known up front, before the worker starts, so clients can render placeholder UI without round-trips. Declarative config is the default; imperative `transforms.*` calls are for one-offs."
---

# Maravilla media transforms

Async media + document processing jobs that derive new storage objects from existing ones — video transcode, image resize, OCR, document → PDF / HTML / Markdown / thumbnails, image-replacement templating, QR injection. The runtime exposes two equivalent paths:

1. **Declarative** — list patterns in `maravilla.config.ts` under `transforms`. The adapter compiles each entry into a synthetic `onStorage({ keyPattern, op: 'put' })` handler that fires every transform in `Promise.all` whenever a matching key lands. **Default for all "every upload of type X gets these renditions" cases.**
2. **Imperative** — call `platform.media.transforms.transcode/thumbnail/resize/ocr/probe(...)` from a route or event handler. For one-off jobs, on-demand re-derivation, or when the source key isn't predictable from a pattern.

Both paths return a `JobHandle` whose `output_key` is **deterministic** — content-addressed via `keyFor(srcKey, spec)`. Clients can render placeholder UI for the derived asset before the worker even starts.

## Declarative: `transforms` in `maravilla.config.ts`

```ts
import { defineConfig } from '@maravilla-labs/platform/config';

export default defineConfig({
  transforms: {
    // Every video upload → mp4 + webm + a 1s thumbnail.
    'uploads/videos/**': {
      transcode: [
        { format: 'mp4', max_width: 1920, bitrate_kbps: 4000 },
        { format: 'webm', max_width: 1920 },
      ],
      thumbnail: { at: '1s', width: 640, format: 'jpg' },
    },
    // Every photo → two webp variants. `variants` is sugar for a `resize` array.
    'uploads/photos/**': {
      variants: [
        { width: 1600, format: 'webp', quality: 85 },
        { width: 400,  format: 'webp', quality: 80 },
      ],
    },
    // PDF receipts → OCR text dump.
    'uploads/receipts/**': {
      ocr: { lang: 'eng+deu' },
    },
  },
});
```

**Pattern syntax:** glob patterns matched against the full storage key (`**` = any depth, `*` = single segment). Multiple matching entries all run.

## Imperative: `platform.media.transforms`

The full method surface is exported from `@maravilla-labs/platform` — import the types and let `tsc` / your IDE give you the canonical shape. Method list:

| Group | Methods |
|---|---|
| Media | `transcode` · `thumbnail` · `resize` · `probe` · `ocr` |
| Documents | `docToPdf` · `docThumbnail` · `docConvert` · `docToMarkdown` · `docToHtml` · `docReplaceImages` · `docInsertQrCode` |
| Status | `job(id)` |

`probe` returns a `MediaInfo` synchronously. Everything else returns a `JobHandle` and runs in the background.

```ts
import { platform } from '@maravilla-labs/platform';
import type { TranscodeOpts, DocReplaceImagesOpts } from '@maravilla-labs/platform';

// Inside a route handler / event handler / workflow:
const opts: TranscodeOpts = { format: 'mp4', max_width: 1920 };
const job = await platform.media!.transforms.transcode('uploads/videos/lecture-01.mov', opts);
// job.output_key is already known — render UI now, even though job.status === 'pending'.
console.log(job.output_key); // "__derived/<srcHash>/<variantHash>.mp4"
```

## `keyFor` — deterministic output keys

The output key is `__derived/<srcHash>/<variantHash>.<ext>` where each hash is the first 16 hex chars of `SHA-256(...)` over the source key and the canonical (key-sorted) JSON of the spec. The same helper runs **client-side** so UI can pre-compute the URL before the upload completes:

```ts
import { keyFor } from '@maravilla-labs/platform';

// Browser: render the variant's thumbnail immediately upon upload start.
const thumbKey = keyFor('uploads/videos/lecture-01.mov', {
  kind: 'thumbnail',
  at: '1s',
  width: 640,
  format: 'jpg',
});
// thumbKey === "__derived/abc123…/def456….jpg" — placeholder src ready before the job runs.
```

The Rust worker derives the **identical** key via `crates/platform/src/media/transforms/derive_key.rs`. Cross-language golden vectors at `crates/platform/tests/derive_key_vectors.json` keep the two in lockstep — don't reimplement the helper, import it.

## Spec types

All `*Opts` types and `JobHandle` / `JobStatusResponse` / `MediaInfo` ship from `@maravilla-labs/platform` — import them; don't reinvent them. Notes worth knowing without opening the file:

- Document inputs LibreOffice handles: `.docx`, `.doc`, `.odt`, `.rtf`, `.xlsx`, `.xls`, `.ods`, `.pptx`, `.ppt`, `.odp`, `.csv`, `.html`, `.txt`, `.epub`, `.md`.
- `DocFormat` = `'pdf' | 'docx' | 'odt' | 'xlsx' | 'html' | 'txt' | 'rtf'`.
- Doc-thumbnail `page` is **1-indexed** (the cover page is `1`, not `0`).
- `OcrOpts.lang` accepts ISO 639-2 + `+`-separated combinations (`'eng+deu'`); the language data must be installed server-side, default `'eng'` always works.
- Image references in `docReplaceImages` and the rendered targets in `docInsertQrCode` use `{ src_key }` keys pointing at images already in `STORAGE` — bytes flow through Storage, not the request body.

## Lifecycle: when to use which path

| Scenario | Use |
|---|---|
| "Every upload to `prefix/X` gets these N renditions" | Declarative `transforms` block |
| "User clicked _Generate alternative encoding_" | Imperative `transforms.transcode` from a route |
| "Every uploaded contract auto-renders a PDF preview" | Imperative `docToPdf` from an `onStorage` handler |
| "Render this template for THIS user with their logo" | Imperative `docReplaceImages` from a route — placeholders and/or named objects |
| Re-derive after a spec change | Imperative — write a one-off script that lists the prefix and calls the transform per object |
| Probe before deciding what to do | `transforms.probe(srcKey)` — synchronous, returns dimensions/duration/codecs |
| Cancel an in-flight job | Not supported v1. Job will run to completion or failure. |

## Document templating: image replacement + QR

Two design choices when filling a `.docx` / `.odt` / `.pptx` template:

| Strategy | When to use | What's preserved |
|---|---|---|
| **Placeholder text-tag** (`'{{LOGO}}'`) | User types a tag in their template. Matches the literal string. Simplest UX. | Image lands at the matched position; you can't easily preset frame size, border, or wrap |
| **Named object** | Template author drops a dummy image and names it (Word: Format → Anchor → Properties → Name). | The original frame's exact size, border, anchor type, and text-wrap settings — the new image just "fills" the existing frame |

`docReplaceImages` accepts BOTH in one call — most realistic templates mix the two. `docInsertQrCode` reuses the same placeholder/named-object anchor mechanism but generates the PNG bytes server-side from a payload string, so the caller doesn't have to upload an image first.

```ts
// Generate a per-invoice PDF: brand logo (named object) + per-row data (placeholders)
// + a backlink QR (placeholder).
await Promise.all([
  platform.media!.transforms.docReplaceImages(`templates/invoice.docx`, {
    output_format: 'pdf',
    namedObjects: { 'BrandLogo': { src_key: 'brand/logo.png' } },
    placeholders: { '{{CUSTOMER_LOGO}}': { src_key: customerLogoKey } },
  }),
  platform.media!.transforms.docInsertQrCode(`templates/invoice.docx`, {
    output_format: 'pdf',
    codes: [{
      placeholder: '{{QR_BACKLINK}}',
      payload: `https://app.example.com/invoice/${invoiceId}`,
      size: 256,
    }],
  }),
]);
```

## Status & retries

- Workers retry on transient failure. After the configured retry budget the job becomes `status: 'failed'` and stays there.
- Polling: `await platform.media!.transforms.job(jobId)` returns `{ id, status }`.
- Push-based: subscribe to REN events `transform.complete` / `transform.failed` — see [realtime](../maravilla-realtime/SKILL.md). Pattern: client renders placeholder via `keyFor` immediately, REN flips it to "ready" the moment the worker reports complete.

## Footguns

- **`probe` is sync, transforms are async.** `probe` returns a `MediaInfo` directly. Everything else returns a `JobHandle` and runs in the background.
- **Output keys live under `__derived/`.** Don't collide. Don't write to that prefix manually. Don't include policies on it — derived assets inherit the visibility of their source via the runtime, not your config.
- **Declarative entries fire on every put — including overwrites.** If a user re-uploads, every transform re-runs and overwrites. That's usually what you want; just be aware.
- **`keyFor` must match Rust byte-for-byte.** If you find yourself reimplementing canonical JSON or hashing, you're holding the wrong end. Import `keyFor` from `@maravilla-labs/platform`.
- **OCR languages are server-installed.** `lang: 'eng+jpn'` only works if the Tesseract language data is provisioned. Default `'eng'` is always safe.
- **Doc templating placeholders are matched verbatim, including the braces.** `'{{LOGO}}'` matches the literal seven-character string in the document — the `{{ }}` style is a convention you adopt, not regex / Mustache. Missing tags are silently skipped (the operation is idempotent).
- **Named-object replacement requires the template author to set the object's `Name` property** in Word/Writer. Anonymous shapes don't get matched; users who haven't set the name see the swap silently no-op.
- **`docInsertQrCode` payload limit is 1500 bytes.** Larger payloads encode but produce a QR too dense to scan reliably — the platform rejects them up front.
- **Document outputs preserve the input format unless `output_format` is set** on `docReplaceImages` / `docInsertQrCode`. Render to PDF if you don't want the user receiving an editable .docx of their own template back.
- **`docToHtml` is the right pick for email rendering and iframe embedding** because the output is one self-contained file — no sidecar assets, no broken images. `docConvert(to: 'html')` exists too but produces multi-file HTML; use `docToHtml` for the single-file case.

## See also

- [maravilla-storage](../maravilla-storage/SKILL.md) — uploads land here first; `__derived/` lives in the same bucket
- [maravilla-events](../maravilla-events/SKILL.md) — declarative `transforms` compiles into `onStorage` handlers
- [maravilla-realtime](../maravilla-realtime/SKILL.md) — REN events for transform lifecycle
- Live Maravilla reference — <https://www.maravilla.cloud/docs/media-transforms> · <https://www.maravilla.cloud/llms-full.txt>
