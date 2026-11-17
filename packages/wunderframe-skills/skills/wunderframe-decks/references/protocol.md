# The Wunderframe deck protocol v1 — and bringing your own stack

Read this when the deck is NOT the template (reveal.js, Svelte, React, a hand-written page, an export from another tool), or when changing `src/deck.js`.

## Contents
1. The protocol
2. Steps inside a slide (`build` / `builds`)
3. Minimal implementation
4. reveal.js bridge
5. A deck built with a framework (Svelte/React/…) → one file
6. Live data (`fetch` from the deck)
7. Pitfalls when bringing your own deck

## 1. The protocol

Plain objects over `window.postMessage`, tagged `wf: 'deck'`, version `v: 1`.

**Screen → deck (commands)**

| message | meaning |
|---|---|
| `{ wf:'deck', v:1, cmd:'next' }` | next step, else next slide |
| `{ …, cmd:'prev' }` | previous step while building up, else previous slide |
| `{ …, cmd:'first' }` / `'last'` | first / last slide |
| `{ …, cmd:'goto', index }` | 0-based slide |
| `{ …, cmd:'hello' }` | answer with the current state |
| `{ …, cmd:'audio', on }` | sound for the deck's videos (optional to handle; the helper does it for `<video>`) |

**Deck → screen (state)** — post to `window.parent` with target origin `'*'` (the frame's origin is opaque) after EVERY change, and once when loaded with `ready: true`:

```js
{ wf: 'deck', v: 1, state: { index, count, title, notes, ready: true /* first post only */ } }
```

- `index` 0-based, `count` ≥ 1 — both always count **slides**, never steps.
- `title` (≤ 200 chars) and `notes` (≤ 4000 chars) are plain text for the phone/lectern/prompter.
- `ready: true` tells the remote "I just loaded" — a screen that restarted mid-talk is at slide 1, and the remote answers with `goto` to where it was. Without it, a reloaded screen stays on slide 1.
- Act only on `data.wf === 'deck'`. Detect a screen with `window.parent !== window`. Outside Wunderframe nothing changes — keyboard and clicks keep working.

The laser pointer (`{ wf:'deck', pointer }`) is drawn by the screen above the frame; it never reaches the deck. It assumes a **16:9 slide centered in the frame**.

**Web videos** (`{ wf:'deck', v:1, embeds: [{ id, src, x, y, w, h, playing }] }`, deck → screen): YouTube/Vimeo players the screen draws above the frame, `x y w h` as fractions of the deck's frame, `playing` true to start it. The step helper sends this for every `<iframe>` with a YouTube/Vimeo address (blanking the frame inside the deck); a deck with its own engine may post it itself. Post again whenever the list, a position or `playing` changes; `embeds: []` removes them. The screen rebuilds the address from the video id (allow-list), at most 4 players.

## 2. Steps inside a slide

Optional fields in the state: `build` (steps shown, 0 = none yet) and `builds` (steps the slide has; 0/absent = none). While a slide has steps left, the deck uses `next` itself and only then changes slide. The remote shows "step 2 of 3"; slide pictures, the grid and notes stay per slide.

A deck that cannot add these to its own state may post them alone: `{ wf:'deck', v:1, build: { build, builds } }` — that is what the `data-wf-step` helper does. **A state that carries its own `builds` wins** over a separate build message, so don't mix the two for the same slide.

Back semantics to copy (PowerPoint/Keynote): while building a slide up, `prev` removes the last step; `prev` that leaves for the slide before lands on it **finished** (all steps in), and a further `prev` goes on to the slide before that without undoing steps. `goto`/`first`/`last`/`next` arrive with nothing revealed.

If the deck is plain HTML, don't implement steps yourself: use `data-wf-step` / `data-wf-play` (see `steps-and-media.md`); the screen injects the helper whenever the page contains those attributes or a `<video>`.

## 3. Minimal implementation

```js
const embedded = window.parent !== window;
let current = 0, first = true;
const slides = [...document.querySelectorAll('section')];

function show(i) {
  current = Math.max(0, Math.min(slides.length - 1, i));
  slides.forEach((s, n) => (s.hidden = n !== current));
  report();
}
function report() {
  if (!embedded) return;
  const s = slides[current];
  window.parent.postMessage({ wf: 'deck', v: 1, state: {
    index: current, count: slides.length,
    title: s.dataset.title ?? '', notes: s.dataset.notes ?? '',
    ...(first ? { ready: true } : {})
  } }, '*');
  first = false;
}
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.wf !== 'deck') return;
  if (m.cmd === 'next') show(current + 1);
  else if (m.cmd === 'prev') show(current - 1);
  else if (m.cmd === 'first') show(0);
  else if (m.cmd === 'last') show(slides.length - 1);
  else if (m.cmd === 'goto' && Number.isInteger(m.index)) show(m.index);
  else if (m.cmd === 'hello') report();
});
show(0);
```

Hide non-current slides with `hidden` / `display:none` (the step helper finds "the slide on show" as the one whose steps are visible — an ancestor with `display:none`, `visibility:hidden` or computed `opacity: 0` counts as not on show). Never animate a whole slide from opacity 0.

The template's `src/deck.js` is this plus scaling, notes from `<aside class="notes">` (or a `data-notes` attribute), keys → self-posted commands (so local keys take the exact remote path), an optional progress bar, and the bundled helper.

## 4. reveal.js bridge

`Reveal.next()` already steps through fragments before changing slide, so the bridge only reports and maps Back:

```js
const embedded = window.parent !== window;
const slides = () => Reveal.getSlides();
const here = () => slides().indexOf(Reveal.getCurrentSlide());

function report(ready) {
  if (!embedded) return;
  const f = Reveal.getIndices().f;
  const builds = Reveal.getCurrentSlide().querySelectorAll('.fragment').length;
  window.parent.postMessage({ wf: 'deck', v: 1, state: {
    index: here(), count: Reveal.getTotalSlides(),
    build: f === undefined ? 0 : f + 1, builds,
    title: Reveal.getCurrentSlide().dataset.title || '',
    notes: Reveal.getSlideNotes() || '',
    ...(ready ? { ready: true } : {})
  } }, '*');
}

let arrivedBack = false;
function go(i, finished) {
  const s = slides()[i];
  if (!s) return;
  arrivedBack = !!finished;
  const n = s.querySelectorAll('.fragment').length;
  const { h, v } = Reveal.getIndices(s);
  Reveal.slide(h, v, finished && n ? n - 1 : undefined);
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.wf !== 'deck') return;
  if (m.cmd === 'next') { arrivedBack = false; Reveal.next(); }
  else if (m.cmd === 'prev') {
    const f = Reveal.getIndices().f;
    if (!arrivedBack && f !== undefined && f >= 0) Reveal.prev();
    else go(here() - 1, true);
  }
  else if (m.cmd === 'first') go(0);
  else if (m.cmd === 'last') go(slides().length - 1);
  else if (m.cmd === 'goto') go(m.index);
  else if (m.cmd === 'hello') report();
});

Reveal.on('ready', () => report(true));
Reveal.on('slidechanged', () => report());
Reveal.on('fragmentshown', () => report());
Reveal.on('fragmenthidden', () => report());
```

Then make the reveal deck offline: install reveal.js from npm (not the CDN), import its CSS/theme, bundle with the single-file recipe below. Use reveal's fragments, not `data-wf-step`, in a reveal deck (one step system per deck). Set reveal's `width: 1920, height: 1080` and disable its `hash`/`history` options (sandboxed frames have no history).

## 5. A deck built with a framework → one file

Any Vite-based deck (Svelte, React, Vue, Tailwind…) becomes one file with:

```js
// build-deck.mjs (or the project's vite.config for a dedicated entry)
import { build } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
await build({
  root: 'deck-export',            // an index.html + main.ts that mounts ONLY the deck
  configFile: false,
  plugins: [/* svelte(), react(), tailwindcss() … */, viteSingleFile()],
  build: { outDir: 'deck-export/dist', target: 'safari14', assetsInlineLimit: 100_000_000,
           cssCodeSplit: false, modulePreload: { polyfill: false } }
});
```

- Mount the deck component alone (no router, no app shell, no SvelteKit/Next runtime): a separate `index.html` + `main.ts` that imports the slide component and mounts it on `document.body`.
- Fonts: import `@fontsource/<family>/<subset>-<weight>.css` files, or fetch the Google Fonts CSS **at build time** and replace each `url(https://…woff2)` with a `data:font/woff2;base64,…` URL (send a Safari user-agent so you get woff2). Never ship a `<link href="https://fonts.googleapis.com/…">`.
- Assets the app references from `/static` or `/public` by absolute path are not inlined by Vite: replace them with `data:` URLs in the output, or import them from the component so Vite inlines them.
- Polyfills for Safari 14-class engines if the code (or the framework's runtime) uses them: `Object.hasOwn`, `Array.prototype.at`, `structuredClone`. Put them at the top of `main.ts`, before importing the framework.
- Then run the template's checker on the result: `node <template>/scripts/check.mjs deck-export/dist/index.html`, and rehearse it sealed by copying the template's `preview/` + `scripts/serve.mjs` next to it, or by uploading and using Wunderframe's **Preview and rehearse**.

## 6. Live data (`fetch` from the deck)

What a screen actually does: it downloads the deck file from Wunderframe, turns it into a `blob:` URL and frames it with `sandbox="allow-scripts allow-pointer-lock"`; the page itself is served with only `content-security-policy: sandbox allow-scripts …`. There is **no connect-src restriction while playing**, so `fetch()` / `EventSource` / `WebSocket` to an `https://` endpoint work — when:

- the screen has internet at that moment, and
- the endpoint answers CORS for an opaque origin: requests carry `Origin: null`, so it must send `Access-Control-Allow-Origin: *` (or `null`); no cookies or credentials are ever sent.

Where it does NOT work: the **slide pictures** for the remote (captured with `connect-src 'none'`), screens that are offline, and the template's sealed rehearsal (`npm run preview` blocks the network on purpose — use `npm run dev` to try a live feed). So a live slide (a counter, a poll result from your own API, a status board) must render a complete, sensible slide from data baked in at build time, and only *update* it when the fetch succeeds. Never let a slide wait for the network, never change slides from fetched data (every screen of the room must stay in step), and time out quickly. The checker warns about `fetch` so this stays a conscious choice.

## 7. Pitfalls when bringing your own deck

- **Report every build.** If your code reveals something on Next by itself (a toggle, an extra state), the screen does not know a step is waiting unless you say so: use `data-wf-step`, or add `build`/`builds` to the state for that slide. Otherwise the remote shows no "step 1 of 1".
- **Keep practice UI out of the frame.** Rehearsal panels, timers or learning cards may exist in the same code only behind keys or when `embedded` is false — the screen shows the whole frame.
- **Steps, not timed choreography.** Content the speaker talks through is a step; entrances settle within ~0.8 s (the remote's slide pictures are taken ~1 s after a slide arrives, and the speaker must be able to hold a reveal).
- **Deterministic.** Every screen in a room runs its own copy: no `Math.random()` layouts, no timers that change slides, no state from storage.
- **Test with the network off.** Open the built file straight from disk with Wi-Fi off; anything that changes is a bug on stage.
- **Publishing the file on a website too?** Some static hosts treat `*.html` as routes; serve the copy as `talk.deck`. Upload the real `.html` (or `.zip`).
