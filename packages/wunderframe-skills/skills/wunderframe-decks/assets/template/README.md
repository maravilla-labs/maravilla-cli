# Talk deck for Wunderframe

With npm (best — live preview while you write):

```bash
npm install
npm run dev       # write: live preview of the screen + remote at /preview/
npm run media     # photos → JPEG ≤ 2560 px, videos → small MP4 (ffmpeg); build runs it too
npm run build     # dist/<name>.html (no videos) or dist/<name>.zip (with videos) + checks
npm run preview   # rehearse the built file sealed like a screen (network blocked)
```

Without npm (no network, no Node packages — Python 3 only):

```bash
node scripts/media.mjs               # pictures and videos first, if Node exists (ffmpeg for videos)
python3 scripts/single.py            # the same dist/<name>.html / .zip, then the checks
```

Slides are `<section>`s in `index.html`; notes go in `<aside class="notes">`; `data-wf-step` builds a slide up; `<video data-wf-play>` starts on Next. Theme tokens, layouts and building blocks in `src/deck.css`; fonts in `src/fonts/`. Pictures in `src/assets/`, videos in `public/media/` (referenced as `/media/x.mp4`).

Upload on your Wunderframe presenter link → *Upload my presentation*.

Fonts: Inter and JetBrains Mono, SIL Open Font License 1.1 (`src/fonts/LICENSE-*.txt`).
