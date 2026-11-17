# Steps, videos, pictures and fonts

## Steps (`data-wf-step`)

```html
<li data-wf-step>…</li>                 <!-- appears on the next press, in DOM order -->
<p data-wf-step="2">…</p>               <!-- explicit order; equal numbers appear together -->
<video data-wf-play muted playsinline poster="./src/assets/cover.jpg" src="/media/demo.mp4"></video>
                                        <!-- shows the poster, plays on the next press -->
```

How it behaves (the helper is Wunderframe's own — identical on the screen, in the template preview and standalone):

- Next reveals the next group; when the slide has none left, Next changes slide. The remote shows "step n of m".
- Back while building up removes the last step (a video goes back to its poster). Back from the following slide lands on this slide **finished**; another Back moves on to the slide before.
- A slide reached by `goto` / first / last / Next starts with nothing revealed.
- Numbers: use them on **all** steps of a slide or on **none**. Unnumbered steps come after numbered ones.
- **Do not nest** steps (a `data-wf-step` inside another).
- **Do not hide steps in your CSS** (`[data-wf-step]{visibility:hidden}` / `opacity:0`): the helper only sets and clears an inline `visibility`, so a stylesheet rule would keep the step hidden forever. Slide pictures for the remote are taken without the helper and show every step in — which is what you want.
- To animate a reveal, key off the inline style the helper removes (the template does this):
  `[data-wf-step]:not([style*='visibility: hidden']) { animation: step-in .4s ease-out both; }`
- A step's element must be inside the slide that is on show; the helper finds that slide as "the one whose steps are visible". Slides that are not current must be `hidden`/`display:none`.
- Plan the steps with the speaker: a step is a press they must remember. Note it in the slide's notes ("2 presses: list, then the punchline").

## Entrances, timing and the slide pictures

Wunderframe photographs every slide for the remote (current/next slide, the grid) **without the helper, so with every step shown, about 1 s after the slide arrives**. Two consequences:

- Content that animates in on a timer after ~1 s is **missing from the picture** — the speaker's phone shows a half-empty slide. Keep entrance animations (the template's `class="enter" style="--d:.2"`) settled within ~0.8 s, and turn anything later into a step the speaker presses. The checker warns about delays over 1 s; `npm run preview` → **Slides** shows the pictures the same way.
- Steps need nothing special: they are all in the picture.

Also: no `Math.random()` in layouts or particles (every screen of a room runs its own copy, so they would differ), no count-up animations on numbers that matter, and endless background animation only `transform`/`opacity`, never large animated `blur()` filters. `references/design.md` §7 has the reasoning.

## Videos

Where they go: `public/media/<file>.mp4`, referenced as `/media/<file>.mp4` in `index.html`. The build rewrites that to `media/…` and packs the zip.

What Wunderframe does with a video named in a zip deck:

| video | result |
|---|---|
| in the zip, ≤ 8 MB | folded into the page as a `data:` URL (costs +33 % of the 25 MB page budget) |
| in the zip, > 8 MB | stored as a library video, played from the screen's own storage (pre-loaded when backstage opens) |
| not in the zip / bigger than the zip allows | a slot: after uploading, **Videos in this presentation → Add video** with that file name (≤ 1 GB). Until then the slide shows the poster. |

The build decides this for you within the limits (zip ≤ 40 MB, page ≤ 25 MB) and prints which videos to add by hand.

Rules of thumb:

- **MP4, H.264 video + AAC audio**, 1080p or 720p. WebM/MOV are accepted but Wunderframe plays a 720p MP4 copy of them. MKV/AVI: convert first (`ffmpeg -i in.mov -c:v libx264 -crf 22 -preset slow -c:a aac -b:a 160k -movflags +faststart out.mp4`).
- **Faststart.** Many exports put the MP4's index (`moov`) at the end; a screen that streams the file (older players, the web player, before pre-loading finished) then shows nothing until all of it has arrived. The checker warns; fix without re-encoding: `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`.
- Always give a `poster` (a JPEG/WebP from `src/assets/`, inlined) — it is what the slide shows before Next, while a slot is empty, and in the slide picture on the remote.
- `muted playsinline` on every video. Sound is controlled for you: the screen sends `audio on` when that stage plays sound and the speaker's remote has sound on; the helper unmutes. Never rely on unmuted autoplay.
- Background loops: `<video autoplay muted loop playsinline>` without `data-wf-play`.
- **YouTube / Vimeo**: a plain embed `<iframe src="https://www.youtube-nocookie.com/embed/<id>" data-wf-play>` works. It cannot play *inside* the sealed deck (the sandbox is inherited: no origin, no referrer — YouTube refuses), so the helper blanks it and the **screen draws the real player above the slide** at the same spot. Add `data-wf-play` so Next starts it and Back stops it — nobody can press a play button on a stage screen (or put `autoplay=1` in the address to start it when the slide appears). Only youtube.com / youtube-nocookie.com / youtu.be / vimeo.com addresses are drawn. It still needs internet on the screen and nothing of it is kept on the device: for a talk that must not fail, download the video and use a file. Slide pictures for the remote show a dark box there.
- No `fetch` of video data, no canvas reads of a video: the addresses are swapped in by the player and are cross-origin.

## Pictures

- Put them in `src/assets/` and reference them relatively (`./src/assets/x.jpg`) — in `<img>`, CSS `url()`, or `poster`. Both builds inline them.
- Budget: the whole page ≤ 25 MB and base64 adds a third. A full-screen photo needs ≤ 2560 px width; JPEG q≈80 or WebP. A 20-photo deck at ~400 KB each is fine; 20 straight-from-camera JPEGs are not. `scripts/single.py` shrinks photos over 2560 px when Pillow is available; with npm, shrink them yourself first.
- **No AVIF, no HEIC** (Safari 14-class screens can't decode AVIF; no browser shows HEIC, the iPhone default). WebP, JPEG, PNG, SVG are safe.
- Shrinking / converting: `sips -Z 2560 -s format jpeg -s formatOptions 80 in.heic --out out.jpg` (macOS), `cwebp -q 80 -resize 2560 0 in.jpg -o out.webp`, or Pillow (`ImageOps.exif_transpose` first, so phone photos stay upright).
- A photo of a drawing or a page: crop to the paper and use `figure.paper` (white mat, shadow, `--tilt`); a face: `figure.portrait` with `object-position` on the face.

## Fonts

- The template ships its fonts as files in `src/fonts/` — Inter and JetBrains Mono as **variable** woff2 (every weight in one file), latin + latin-ext — declared in `src/fonts/fonts.css`, which `index.html` links. Both builds inline them. They work without npm.
- Another family: copy its `.woff2` files into `src/fonts/` (the brand's own files, or `node_modules/@fontsource-variable/<family>/files/*-latin-wght-normal.woff2` after `npm i @fontsource-variable/<family>`, or a static weight from `@fontsource/<family>`), add `@font-face` rules like the existing ones with relative `url()`s, change `--font` / `--mono` in `deck.css`, and delete the files you no longer use (each is 15–90 KB inlined).
- Subsets: `latin` covers English/German/French…; `latin-ext` adds Turkish, Polish, Czech, etc. (ş, ğ, ł, č); add `cyrillic`, `greek`, `vietnamese` files as needed, each with its `unicode-range`. A missing subset silently falls back to a system font for those letters.
- Check the font's licence allows embedding (OFL fonts do; the template's licences are next to the files).
- The checker flags any `@font-face` that still points at a file or URL after the build, and says when a deck has no fonts at all (system fonts look different on every screen).
