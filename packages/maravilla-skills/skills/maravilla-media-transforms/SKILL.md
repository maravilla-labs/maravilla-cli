---
name: maravilla-media-transforms
description: "Async media derivations (transcode video, thumbnail extraction, image resize/variants, OCR) via `platform.media.transforms` and the declarative `transforms` block in `maravilla.config.ts`. Use when ingesting user uploads that need normalised renditions — uploads/photos resized to multiple widths, video transcoded to mp4+webm with a thumbnail, scanned PDFs OCR'd. Critical: derived keys are content-addressed — `keyFor(srcKey, spec)` is known up front, before the worker starts, so clients can render placeholder UI without round-trips. Declarative config is the default; imperative `transforms.*` calls are for one-offs."
---

# Maravilla media transforms

Async media-processing jobs (ffmpeg / image / OCR) that derive new storage objects from existing ones. The runtime exposes two equivalent paths:

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

```ts
interface TransformsService {
  transcode(srcKey: string, opts: TranscodeOpts): Promise<JobHandle>;
  thumbnail(srcKey: string, opts: ThumbnailOpts): Promise<JobHandle>;
  resize(srcKey: string, opts: ResizeOpts): Promise<JobHandle>;
  probe(srcKey: string): Promise<MediaInfo>;       // ffprobe — synchronous result, no job
  ocr(srcKey: string, opts?: OcrOpts | null): Promise<JobHandle>;
  job(id: string): Promise<JobStatusResponse>;     // poll status of any prior job
}

interface JobHandle {
  id: string;
  src_key: string;
  output_key: string;                              // deterministic — see keyFor() below
  status: 'pending' | 'running' | 'complete' | 'failed';
}
```

```ts
import { platform, transforms } from '@maravilla-labs/platform';
import type { TranscodeOpts } from '@maravilla-labs/platform';

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

```ts
interface TranscodeOpts {
  format: 'mp4' | 'webm';
  codec?: string;                  // e.g. 'libx264', 'libvpx-vp9'
  max_width?: number;              // letterbox if needed
  max_height?: number;
  audio_codec?: string;            // 'aac', 'opus'
  bitrate_kbps?: number;
}

interface ThumbnailOpts {
  at: string;                      // '00:00:01' | '1s' | numeric-as-string
  width?: number;
  height?: number;
  format?: 'jpg' | 'png' | 'webp'; // default 'jpg'
  quality?: number;                // 1–100
}

interface ResizeOpts {
  width?: number;
  height?: number;                 // either or both — at least one required
  format: 'jpg' | 'png' | 'webp';
  quality?: number;                // 1–100
  strip_metadata?: boolean;        // strip EXIF for privacy
}

interface OcrOpts {
  lang?: string;                   // tesseract language codes, e.g. 'eng' | 'eng+deu'. Default 'eng'.
}
```

## Lifecycle: when to use which path

| Scenario | Use |
|---|---|
| "Every upload to `prefix/X` gets these N renditions" | Declarative `transforms` block |
| "User clicked _Generate alternative encoding_" | Imperative `transforms.transcode` from a route |
| Re-derive after a spec change | Imperative — write a one-off script that lists the prefix and calls `transcode` per object |
| Probe before deciding what to do | `transforms.probe(srcKey)` — synchronous, returns dimensions/duration/codecs |
| Cancel an in-flight job | Not supported v1. Job will run to completion or failure. |

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

## See also

- [maravilla-storage](../maravilla-storage/SKILL.md) — uploads land here first; `__derived/` lives in the same bucket
- [maravilla-events](../maravilla-events/SKILL.md) — declarative `transforms` compiles into `onStorage` handlers
- [maravilla-realtime](../maravilla-realtime/SKILL.md) — REN events for transform lifecycle
- Live Maravilla reference — <https://www.maravilla.cloud/docs/media-transforms> · <https://www.maravilla.cloud/llms-full.txt>
