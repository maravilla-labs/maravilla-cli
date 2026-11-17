---
name: wunderframe-decks
description: "Create presentations (slide decks / talks / keynotes / school presentations / pitches) that a speaker uploads to Wunderframe and drives from their phone, the lectern, a clicker or hand signs. Starts by asking about the talk (audience, length, goal, the one take-away, brand, existing material — outlines, scripts, notes, pictures, logos, old slides, videos), proposes a structure and a per-slide plan, then builds an HTML deck on a 1920×1080 canvas with design guidance for big rooms, speaker notes for the remote and prompter, build-up steps (data-wf-step), videos and YouTube/Vimeo players that start on Next (data-wf-play), and fully offline output: ONE self-contained HTML file (fonts, pictures, scripts inlined) or a .zip with videos. Works in Claude Code, the Claude desktop app and claude.ai — with npm (Vite, live preview that behaves like a Wunderframe screen and the remote) or without (a Python script builds the same single file). Ships a starter template with layouts (title, split, statement, quote, timeline, flow, key terms, cards, full-bleed), a checker for the 25 MB / 40 MB / offline / protocol / slide-picture rules. Use this whenever someone wants to make, convert, fix, redesign or prepare a talk or presentation for Wunderframe — 'my slides for the conference', 'turn my outline into a deck', 'help me with my presentation about…', 'make my reveal.js deck work on the stage', 'why does my font not show on the screen', 'add a video to my presentation', 'speaker notes on my phone' — even if they do not say 'deck' or 'Wunderframe protocol'."
---

# Wunderframe decks

Wunderframe plays a speaker's presentation on the venue's screens. The speaker uploads it on their presenter link (or the organizer on the session page / *Present now*), and their phone, the room's lectern, a presentation clicker or hand signs become the remote: slide picture + next slide, notes as a prompter, a step counter, a laser pointer.

What Wunderframe accepts: **one self-contained `.html` (≤ 25 MB)**, a **`.zip` with `index.html` + files (≤ 40 MB)**, or a PDF / `.pptx` (converted to static slides — animations and steps are lost). HTML is the format that keeps everything, so this skill builds HTML.

The four facts that shape every technical decision:

1. **The deck runs sealed.** A screen downloads the file, then frames it as a `blob:` page with `sandbox="allow-scripts"` — opaque origin, no cookies, no storage. Everything the slides *need* must be inside the file: a Google Fonts link, a CDN script or a picture URL is missing on a screen without internet, in the slide pictures, and wherever the venue network is bad. (Live data via `fetch()` is possible but optional — `references/protocol.md`.)
2. **The remote drives it through the deck protocol v1** (`postMessage`, `wf: 'deck'`): `next / prev / first / last / goto / hello / audio` in, `{ state: { index, count, title, notes, ready } }` out. Notes and titles reach the phone only through this. The template implements it; other frameworks: `references/protocol.md`.
3. **Steps are Wunderframe's own helper.** `data-wf-step` and `data-wf-play` (on `<video>` and YouTube/Vimeo `<iframe>`s) are executed by a script the screen injects; the template bundles the identical script. Next reveals a step until the slide has none left; Back works like PowerPoint/Keynote.
4. **Screens are old and photographed.** Lectern Macs and TV boxes may be Safari 14-class WebKit: no AVIF, no `:has()`, no `.at()`. The remote's slide pictures are taken about 1 s after a slide arrives, with every step shown — slow entrance animations are missing there.

## 1. Start with the speaker

Before building anything, find out what the talk is. Read everything the user already gave you first (their message, attached files, the folder they named) and **only ask what is still missing** — one friendly message, a few questions at once, not an interrogation:

> To make this good I'd like to know a few things — answer what you can, skip the rest:
> 1. **What's the talk?** Topic, who's in the room (and what they already know), how long, which language.
> 2. **The one thing** people should remember or do afterwards. Is there a brief or criteria it must meet (a rubric, a call for papers)? Paste it.
> 3. **Your material**: paste an outline, a script or notes, or point me to a folder (or attach files) — pictures, drawings, logos, old slides, videos, a brand guide. Your own pictures make the best slides.
> 4. **The look**: brand colours / fonts / logo, or a mood (calm, bold, playful). Do you know the room — LED wall, TV, projector in a bright room?
> 5. **How you'll present**: notes on your phone or a prompter, index cards, any video or sound?

If they say "just make something", go ahead with sensible defaults and list your assumptions in one line each.

Then **propose before you build**: two or three possible structures in a sentence each with your recommendation, the slide count for the time (≈ 1 per minute for conference talks, 20–40 s per slide for short talks), and — once they pick — a **plan per slide** (ON THE SCREEN / VISUAL / SAY / STEPS / TIME, see `references/design.md` §1). Save the plan as `<talk-slug>-plan.md` next to the deck: it is the speaker's rehearsal sheet. One round of feedback on the plan saves many rounds on slides. Skip the plan only for a tiny deck or a pure conversion.

**Read `references/design.md` before writing slides** — structure, how much text, type sizes on the canvas, colour and brand tokens, pictures, motion vs. steps, notes written for speaking, timing, and a final checklist.

## 2. Find out where you are running

Claude Code (terminal / IDE / desktop Code session) runs on the speaker's computer; claude.ai and desktop chats run in a sandbox that may have no network and no browser, and the user downloads the result from the folder that environment names. Check with commands — `node -v`, `python3 -V`, `ffmpeg -version`, and one `npm install` attempt in the deck folder — then pick:

- **A. npm works** → the full workflow below (`npm run dev / build / preview`).
- **B. no npm** (missing, offline, install fails) → same template, built with `python3 scripts/single.py` (standard library only) into the same single file / zip.

Don't retry a failing install. Details, per-environment output folders, screenshots without a browser, and a last-resort by-hand path: `references/environments.md`.

## 3. Build the deck from the template

```bash
cp -r <this-skill>/assets/template ./my-talk     # a folder named after the talk
cd my-talk && npm install                         # path A only
```

Set `"name"` in `package.json` to a slug for the talk (it names the output files) and `<title>` / `lang` in `index.html`. The template is plain HTML + CSS + a small engine (`src/deck.js`) — no framework, so any speaker or agent can edit it, and both build paths can build it. If the user already has a Svelte/React/reveal.js deck, keep their stack and read `references/protocol.md` (bridge code + single-file recipe) instead.

Authoring lives in `index.html`, one `<section>` per slide inside `<main class="stage">`:

```html
<section class="split" data-title="Why now">
  <div class="text">
    <p class="kicker">Part 1 · Context</p>
    <h2>One idea <span class="hl">per slide</span></h2>
    <ul class="points">
      <li data-wf-step>appears on the first Next</li>
      <li data-wf-step>then this one</li>
    </ul>
  </div>
  <figure class="paper" style="--tilt: 2deg"><img src="./src/assets/drawing.jpg" alt=""></figure>
  <aside class="notes">
    <p>What I say here — keywords, short sentences.</p>
    <p>2 presses. → next: the numbers</p>
  </aside>
</section>
```

- **Notes** (`<aside class="notes">`, or `data-notes="…"` on the section) are the prompter on the phone/lectern — written for *speaking*, ≤ 4000 chars, every slide. The checker counts them.
- **Title** (`data-title`) is what the remote's slide list shows; else the first heading.
- **Layouts** (class on the section): `title`, `divider`, `split`, `statement`, `quote` (also `quote split` with a picture), `bleed`, `closing`; modifier `top` (content from the top). **Building blocks**: `header.head` + `.kicker` + `h2` with `.hl`, `ul.points` (`.icons`), `ol.numbered`, `dl.terms` (glossary), `ol.timeline`, `.flow` (boxes with arrows), `.cards` (`--cols`), `.card`, `.callout`, `.chip`, `figure.paper`, `figure.portrait`, `.badge` + inline-SVG icons from the sprite, `.progress`, `.foot`. Each is documented where it is defined in `src/deck.css`; the template's slides show each one. Delete the slides you don't need.
- **Theme** = the tokens at the top of `src/deck.css` (colours with meanings, type scale, radius, stage background; `<html data-theme="light">` for bright rooms). Map the brand onto them first.
- **Fonts** ship in `src/fonts/` (Inter + JetBrains Mono, variable, latin + latin-ext) and are inlined by both builds. A brand font: copy its `.woff2` there and add an `@font-face` in `src/fonts/fonts.css`. Never link Google Fonts.
- **Pictures** in `src/assets/`, referenced relatively; **videos** in `public/media/`, referenced as `/media/<file>.mp4`. **They are always prepared before they go in** — `npm run media`, which every `npm run build` runs first: HEIC/AVIF/TIFF → JPEG and photos ≤ 2560 px; every video → a small streamable MP4 with ffmpeg (H.264 + AAC, ≤ 1080p, faststart); originals kept in `originals/`, references fixed. If it stops because a tool is missing, install it (it prints the command) — never ship a HEIC or a raw phone video. Path B: `single.py` handles pictures; videos via `node scripts/media.mjs` or the ffmpeg commands in `references/steps-and-media.md`.
- **Canvas**: 1920×1080, scaled as a whole and letterboxed into whatever box the room's layout gives the deck (a split LED wall, a side band) — keep important content off the outer edges. Keep it 16:9: the laser pointer assumes it.
- **Motion**: entrances (`class="enter" style="--d:.2"`) settle within ~0.8 s; anything the speaker talks through is a step.

Steps, videos, YouTube/Vimeo and sound: `references/steps-and-media.md` — read it before using `data-wf-step` / `data-wf-play` beyond a basic list, and before adding any video.

## 4. Preview while you build (path A)

```bash
npm run dev          # opens http://localhost:5173/preview/
```

The preview stands in for a Wunderframe screen **and** the remote: the deck framed as on a screen, Next/Back (→ Space ←), "Slide n of m · step b of m", the notes as the phone shows them, a **Slides** grid (G), **Reload screen** (R — the deck must come back on the same slide), a sound toggle. It hot-reloads as you edit. The deck alone is at `/` (`#5` jumps to slide 5).

Look at the slides, don't trust the markup: with a browser tool, check the grid for overflow, tiny text and empty slides; without one, see "Look at the slides" in `references/environments.md`.

## 5. Build the offline file

Path A: `npm run build` (prepares pictures and videos first). Path B: `node scripts/media.mjs` if Node exists (or the ffmpeg commands), then `python3 scripts/single.py` (`--out <folder>` to write straight to where the user downloads).

- `dist/<name>.html` — everything inlined: JS, CSS, pictures, fonts. Upload this when the deck has **no videos**.
- `dist/<name>.zip` — only when the deck references videos: `index.html` + `media/…`. Upload the **zip**; Wunderframe unpacks it and plays the videos from its library. The build says which videos fit and which to add afterwards with **Add video**.
- Then the checks run (`node scripts/check.mjs <file>` works on any HTML deck): ✗ = will break on stage, fix it; ! = worth fixing; · = info.

## 6. Rehearse the built file as a screen plays it

```bash
npm run preview      # http://localhost:4178 — the built file, sealed (needs Node, not npm packages)
```

Same harness, but the deck is `sandbox="allow-scripts"`, the step helper is injected as the server injects it, and a Content-Security-Policy blocks every network request — anything the deck tries to load appears in red under the notes. **Slides** (G) here shows the slide pictures as the remote will: every step in, frozen 1 s after arrival. Step through the whole talk once before calling it done.

## 7. Hand it over

Deliver the built file where the user can reach it (their folder in Claude Code; in a chat sandbox, the downloads folder that environment names — ask if it names none), with the plan `.md`, and the source folder zipped without `node_modules`/`dist`/`originals` if they want to keep editing. Then tell the speaker, briefly:

- Upload `<name>.html` (or the `.zip` if it has videos) on the presenter link → *Upload my presentation* → **Upload**, then **Preview and rehearse** there. The file goes straight to Wunderframe's storage; a zip is then **unpacked** for a few seconds (its big videos become library videos). Wunderframe photographs every slide for the remote.
- **Or fetch it from an address** when the talk keeps changing or a pipeline builds it: publish the built file at an `https://` URL and use **Fetch from address** on the presenter link or session page. Wunderframe keeps its own copy, so screens never depend on that site; **Fetch again** pulls a new version. A fetch is capped at **25 MB** (a bigger zip must be uploaded). Hosts that treat `*.html` as routes: serve it as e.g. `talk.deck` — Wunderframe checks the bytes, not the name.
- Videos left out of the zip: **Videos in this presentation** → **Add video** per file name (MP4 H.264/AAC, ≤ 1 GB).
- A new version: **Replace** — screens reload it and the remote puts it back on the current slide.
- How to run the talk (prompter, hand signs, laser, sound): `references/presenting.md`.

## When it is not a file deck

Wunderframe can also present its own *stories* (scenes built in the editor, moved on by hand: `create_story`, `set_story_advance`, `present_story`, `story_step` on the Wunderframe MCP). Use that when the user wants the talk built inside Wunderframe from its scenes and data; use this skill when they want a presentation file they own, design freely and can open anywhere.

## Reference files

- `references/design.md` — how to design the talk: plan format, structure and rhythm, text per slide, type scale, colour/brand tokens, pictures and drawings, motion vs. steps, notes, timing, final checklist.
- `references/environments.md` — Claude Code vs. desktop vs. claude.ai: detection, the no-build path (`scripts/single.py`), where output goes, screenshots without a browser, a by-hand fallback.
- `references/steps-and-media.md` — step rules (order, grouping, Back, what not to do), entrance timing, videos (sizes, formats, zip vs. Add video, sound, posters), YouTube/Vimeo, pictures, fonts.
- `references/protocol.md` — the deck protocol v1 in full, `build`/`builds`, web-video `embeds`, reveal.js bridge, framework decks → one file, live data, pitfalls.
- `references/presenting.md` — what the speaker gets on stage: remote, keys, prompter, hand signs, laser, slide pictures, reload behaviour.

## Template map

```
index.html             the slides (edit this) + the inline icon sprite
src/deck.css           theme tokens, layouts and building blocks (edit the tokens)
src/fonts/             woff2 files + fonts.css (@font-face) — inlined by both builds
src/deck.js            engine: scaling, keys, protocol v1, notes/title, progress (no npm imports)
src/wf-runtime.js      Wunderframe's step/sound/web-video helper, verbatim (do not edit)
src/assets/            pictures → inlined
public/media/          videos → zip; reference as "/media/<file>.mp4"
preview/               the screen + remote harness (dev and built modes, slide-picture grid)
scripts/media.mjs      pictures → JPEG ≤ 2560 px, videos → small streamable MP4 (ffmpeg); run by build
scripts/build.mjs      path A: media, then Vite single file + zip + checks
scripts/single.py      path B: the same without npm (Python standard library)
scripts/check.mjs      offline / size / protocol / media / motion / Safari 14 checks
scripts/serve.mjs      sealed rehearsal of the built file (Node only, no packages)
```
