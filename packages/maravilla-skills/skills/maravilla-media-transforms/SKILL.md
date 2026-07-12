---
name: maravilla-media-transforms
description: "Async media + document derivations via `platform.media.transforms` and the declarative `transforms` block in `maravilla.config.ts`. Media: transcode video, thumbnail extraction, image resize/variants, face detection with stored focal points (`detectFaces` / `setFocalPoint` / `getFocalPoint`) powering CSS `object-position` and face-aware `crop: 'focal'` renditions, OCR. Documents (.docx/.odt/.pptx/.xlsx/...): convert to PDF, render page thumbnails, generic format conversion, Markdown extraction (RAG-ready), single-file HTML with inlined images, image-replacement templating ({{TAG}} swap + named-object swap), QR-code injection. Use when ingesting user uploads that need normalised renditions, generating contracts/invoices from templates, or extracting structured content for LLMs. Critical: derived keys are content-addressed — `keyFor(srcKey, spec)` is known up front, before the worker starts, so clients can render placeholder UI without round-trips. Declarative config is the default; imperative `transforms.*` calls are for one-offs."
---

# Maravilla media transforms

Async media + document processing jobs that derive new storage objects from existing ones — video transcode, image resize, image OCR (Tesseract — image inputs only, not PDFs; see the PDF→text pattern below), document → PDF / HTML / Markdown / thumbnails, image-replacement templating, QR injection. The runtime exposes two equivalent paths:

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
    // Photo receipts → OCR text dump. NOTE: `transforms.ocr` is
    // image-only — feeding a PDF to OCR does NOT work (see footguns).
    // Match a path you control to be image uploads only.
    'uploads/receipt-photos/**': {
      ocr: { lang: 'eng+deu' },
    },
    // Avatars → face detection + a face-centered square crop. Detection
    // runs FIRST; `crop: 'focal'` variants automatically wait for it.
    'uploads/avatars/**': {
      detectFaces: true, // or { min_score: 0.7, max_faces: 8, fast: false }
      variants: [
        { width: 256, height: 256, format: 'webp', crop: 'focal' },
        { width: 1024, format: 'webp' },
      ],
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
| Faces / focal points | `detectFaces` · `setFocalPoint` · `getFocalPoint` · `clearFocalPoint` |
| Documents | `docToPdf` · `docThumbnail` · `docConvert` · `docToMarkdown` · `docToHtml` |
| Document templating | **`docTemplateMerge`** (text + images + QR in one render — preferred) · `docReplaceImages` (images only) · `docInsertQrCode` (QR only) |
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

## Face detection & focal points

`detectFaces(srcKey, opts?)` runs on-platform face detection over an image and persists a **focal point** for the source key — the anchor for CSS `object-position` / `background-position` and for face-aware crops. It's a normal queued job (`JobHandle`); the derived JSON artifact at `output_key` is `{ faces: [{x,y,w,h,score}…], face_count, focal: {x,y}, width, height }`, all coordinates normalized `0..1`. Opts (all optional): `min_score` (default `0.6`), `max_faces` (default `32`), `fast` (lower-accuracy/lower-latency). Re-detecting an unchanged image completes instantly from cache. Focal computation: one face → eye-biased box center; several → confidence·area-weighted centroid; none → `(0.5, 0.5)` recorded.

Companion methods (synchronous, no job):

- `setFocalPoint(srcKey, {x, y})` — manual override, `0..=1`. **Manual wins**: later detections refresh the face boxes but never move a manual focal point.
- `getFocalPoint(srcKey)` — `FocalPointRecord | null` (`{ src_key, focal, source: 'faces'|'manual', face_count, faces?, updated_at }`). Point read, cheap enough for SSR on every image.
- `clearFocalPoint(srcKey)` — removes the record; consumers fall back to center.

The SSR pattern for correct art direction on ANY sized container — no cropping needed:

```ts
const rec = await platform.media!.transforms.getFocalPoint(key);
const pos = rec ? `${rec.focal.x * 100}% ${rec.focal.y * 100}%` : '50% 50%';
// <img src={url} style={`object-fit: cover; object-position: ${pos}`} />
```

Face-aware derived crops: `resize` (and `variants` entries) accept `crop: 'focal' | 'center'` — output is EXACTLY `width`×`height` (both required), cover-scaled and cut around the focal point (`'focal'`, falling back to center when none stored) or the geometric center (`'center'`). The resolved focal value is hashed into the derived key, so moving the focal point yields a NEW output key — stale crops are never served, but re-render your URLs (or use `getFocalPoint` + CSS when you don't want new assets per adjustment).

## Lifecycle: when to use which path

| Scenario | Use |
|---|---|
| "Every upload to `prefix/X` gets these N renditions" | Declarative `transforms` block |
| "User clicked _Generate alternative encoding_" | Imperative `transforms.transcode` from a route |
| "Every uploaded contract auto-renders a PDF preview" | Imperative `docToPdf` from an `onStorage` handler |
| "Render this template for THIS user with name + logo + QR backlink" | Imperative `docTemplateMerge` — single call, all substitution kinds in one render |
| "Render this template with ONLY images, no text or QR" | Imperative `docReplaceImages` from a route — placeholders and/or named objects |
| Re-derive after a spec change | Imperative — write a one-off script that lists the prefix and calls the transform per object |
| "Avatar/hero crops must keep faces in frame" | Declarative `detectFaces: true` + `crop: 'focal'` variants |
| "Editor lets the user drag the crop anchor" | Imperative `setFocalPoint` from a route; render via `object-position` or re-derive crops |
| Probe before deciding what to do | `transforms.probe(srcKey)` — synchronous, returns dimensions/duration/codecs |
| Cancel an in-flight job | Not supported v1. Job will run to completion or failure. |

## Document templating: text + image + QR in one call

The headline templating job is `docTemplateMerge` — text substitution + image swap + QR injection in one render. Use it whenever a template needs more than one substitution kind. `docReplaceImages` and `docInsertQrCode` remain available for the narrower images-only and QR-only cases.

Two design choices when targeting a swap (applies to both `docTemplateMerge` and the standalone methods):

| Strategy | When to use | What's preserved |
|---|---|---|
| **Placeholder text-tag** (`'{{LOGO}}'`) | User types a tag in their template. Matches the literal string. Simplest UX. | Image lands at the matched position; you can't easily preset frame size, border, or wrap |
| **Named object** | Template author drops a dummy image and names it (Word: Format → Anchor → Properties → Name). | The original frame's exact size, border, anchor type, and text-wrap settings — the new image just "fills" the existing frame |

`docTemplateMerge` accepts BOTH placeholder and named-object swaps in the same call, plus arbitrary text replacements (`'{{NAME}}' -> 'Acme Corp'`) and server-generated QR codes via the same placeholder mechanism.

```ts
// Generate a per-invoice PDF: customer name + customer logo + brand logo
// + payment QR — all in ONE call, ONE server-side render.
await platform.media!.transforms.docTemplateMerge('templates/invoice.docx', {
  output_format: 'pdf',
  data: {
    '{{CUSTOMER_NAME}}': 'Acme Corp',
    '{{INVOICE_ID}}':    `#${invoiceId}`,
    '{{TOTAL}}':         '€ 1,234.56',
  },
  images: { '{{CUSTOMER_LOGO}}': { src_key: customerLogoKey } },
  named_objects: { 'BrandLogo': { src_key: 'brand/logo.png' } },
  qr_codes: {
    '{{PAYMENT_QR}}': {
      payload: `https://app.example.com/invoice/${invoiceId}`,
      size: 256,
    },
  },
});
```

The composition trap (don't do this): calling `docReplaceImages` then `docInsertQrCode` on the same template spawns soffice twice. `docTemplateMerge` does the same outcome in one daemon — ~3× the throughput.

## Status & retries

- Workers retry on transient failure. After the configured retry budget the job becomes `status: 'failed'` and stays there.
- Polling: `await platform.media!.transforms.job(jobId)` returns `{ id, status }`.
- Push-based: subscribe to REN events `transform.complete` / `transform.failed` — see [realtime](../maravilla-realtime/SKILL.md). Pattern: client renders placeholder via `keyFor` immediately, REN flips it to "ready" the moment the worker reports complete.

## Pattern: extracting text from PDFs (the right way)

The naive `transforms.ocr(pdfKey)` does **not** work — Tesseract is image-only.
Real PDFs need a two-stage pipeline. The right architecture:

1. **Try `docToMarkdown` first.** Cheap, near-instant. Goes through
   `soffice → html → pandoc`. Works for any PDF that has a real text layer
   (most modern PDFs do).

2. **Validate the produced text.** Byte-scan heuristics (looking for `/Font`
   resources) are unreliable — many "text" PDFs use subset fonts that decode
   into garbage Unicode. Check the output instead. Three independent signals
   catch the failure modes:

   ```typescript
   function validatePdfText(text: string): { ok: boolean; reason?: string } {
     const t = text.trim();
     if (!t || t.length < 10) return { ok: false, reason: 'too short' };
     // (1) symbol vs alphanumeric ratio — garbage collapses to brackets/percents
     const alpha = (t.match(/[a-zA-Z0-9]/g) ?? []).length;
     if (1 - alpha / t.length > 0.35) return { ok: false, reason: 'symbol ratio' };
     // (2) average word length — broken spacing produces 1-char or 200-char words
     const words = t.split(/\s+/).filter(Boolean);
     const avg = words.reduce((s, w) => s + w.length, 0) / words.length;
     if (avg < 2 || avg > 15) return { ok: false, reason: 'word length' };
     // (3) vowel ratio — Western languages have vowels; subset-font garbage doesn't
     const letters = t.replace(/[^a-zA-Z]/g, '').toLowerCase();
     if (letters) {
       const v = (letters.match(/[aeiouy]/g) ?? []).length / letters.length;
       if (v < 0.2 || v > 0.7) return { ok: false, reason: 'vowel ratio' };
     }
     return { ok: true };
   }
   ```

3. **If validation fails → escalate.** For each page up to a cap (10 is a
   reasonable default), call `transforms.docThumbnail(pdfKey, { page: N,
   width: 1600, format: 'png' })` to rasterize the page. When each render
   lands (via the `transform.complete` REN event), dispatch
   `transforms.ocr(rasterizedKey)` on the PNG. Concatenate the OCR outputs.

A durable workflow is the right shape for this — the rasterize + OCR pair
is two transform jobs per page, and `step.waitForEvent` gives you the
rendezvous semantics for free. See [maravilla-workflows](../maravilla-workflows/SKILL.md)
for the bridge handler that forwards `transform.complete` REN events onto
the `transform.done` channel that workflows listen on.

Heuristics that don't replace validation but ARE useful for sizing the
escalation fan-out:

```typescript
// Heuristic page count from raw PDF bytes — `/Type /Pages /Count N` first,
// fallback to counting `/Type /Page` headers. Returns 0 on compressed xref.
function pdfPageCount(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes);
  const m = /\/Type\s*\/Pages\b[\s\S]{0,1024}?\/Count\s+(\d+)/.exec(text);
  if (m) { const n = parseInt(m[1], 10); if (n > 0 && n < 10000) return n; }
  return (text.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}
```

## Footguns

- **`probe` is sync, transforms are async.** `probe` returns a `MediaInfo` directly. Everything else returns a `JobHandle` and runs in the background — EXCEPT the focal-point trio (`setFocalPoint` / `getFocalPoint` / `clearFocalPoint`), which are synchronous point reads/writes, no job.
- **`crop` requires BOTH `width` and `height`** — it's crop-to-fill, the output is exactly that box. One-dimension resizes can't crop; the enqueue rejects them with InvalidOpts.
- **`crop` works on jpg/png/webp sources only (v1).** Exotic formats that fall back to the CLI converter get a clear error — convert the image first.
- **`detectFaces` is image-only.** Video sources are rejected up front; extract a `thumbnail` frame first and detect on that.
- **`face_count: 0` and `null` mean different things.** A record with `face_count: 0` says "we looked, no faces" (focal = center); `getFocalPoint` returning `null` says "never detected/set" — both should render as `50% 50%`, but only the latter warrants triggering a detection.
- **Manual focal points survive re-detection.** `setFocalPoint` marks the record `source: 'manual'`; subsequent `detectFaces` runs refresh boxes/count but never move the point. `clearFocalPoint` re-arms automatic behaviour.
- **Output keys live under `__derived/`.** Don't collide. Don't write to that prefix manually. Don't include policies on it — derived assets inherit the visibility of their source via the runtime, not your config.
- **Declarative entries fire on every put — including overwrites.** If a user re-uploads, every transform re-runs and overwrites. That's usually what you want; just be aware.
- **`keyFor` must match Rust byte-for-byte.** If you find yourself reimplementing canonical JSON or hashing, you're holding the wrong end. Import `keyFor` from `@maravilla-labs/platform`.
- **OCR languages are server-installed.** `lang: 'eng+jpn'` only works if the Tesseract language data is provisioned. Default `'eng'` is always safe.
- **`transforms.ocr` is image-only — it CANNOT read PDFs.** The worker hands the raw source bytes to `tesseract <path> outbase -l <lang>`, and the classic Tesseract build only handles raster images (PNG/JPG/TIFF/BMP/GIF). Feeding a PDF either errors with "Cannot recognize image format" or silently times out after the 120s wall-clock budget. Use the pattern in the next section for PDFs.
- **Doc templating placeholders are matched verbatim, including the braces.** `'{{LOGO}}'` matches the literal seven-character string in the document — the `{{ }}` style is a convention you adopt, not regex / Mustache. Missing tags are silently skipped (the operation is idempotent).
- **Named-object replacement requires the template author to set the object's `Name` property** in Word/Writer. Anonymous shapes don't get matched; users who haven't set the name see the swap silently no-op.
- **`docInsertQrCode` payload limit is 1500 bytes.** Larger payloads encode but produce a QR too dense to scan reliably — the platform rejects them up front.
- **Document outputs preserve the input format unless `output_format` is set** on `docReplaceImages` / `docInsertQrCode`. Render to PDF if you don't want the user receiving an editable .docx of their own template back.
- **`docToHtml` is the right pick for email rendering and iframe embedding** because the output is one self-contained file — no sidecar assets, no broken images. `docConvert(to: 'html')` exists too but produces multi-file HTML; use `docToHtml` for the single-file case.
- **`docTemplateMerge` is the default for any templating that needs more than one substitution kind.** Composing `docReplaceImages` + `docInsertQrCode` works but doubles the soffice cold-start cost. Reach for the standalone methods only when you genuinely have just images, or just QR.
- **`docTemplateMerge.data` does verbatim string replacement** — there's no template engine (no `{{#if}}`, no loops, no expressions). Tags are matched literally; choose a delimiter style you don't expect to appear in real document content (`'{{TAG}}'` or `'<<TAG>>'`).
- **Per-row mail merge (one template → many output PDFs from a CSV) is a CALLER-SIDE LOOP.** `docTemplateMerge` takes ONE substitution map per call. For bulk render, iterate in a workflow or event handler.

## See also

- [maravilla-storage](../maravilla-storage/SKILL.md) — uploads land here first; `__derived/` lives in the same bucket
- [maravilla-events](../maravilla-events/SKILL.md) — declarative `transforms` compiles into `onStorage` handlers
- [maravilla-realtime](../maravilla-realtime/SKILL.md) — REN events for transform lifecycle
- Live Maravilla reference — <https://www.maravilla.cloud/docs/media-transforms> · <https://www.maravilla.cloud/llms-full.txt>
