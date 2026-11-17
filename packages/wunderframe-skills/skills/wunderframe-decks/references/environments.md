# Where you are running — and how the speaker gets the file

The same skill runs in Claude Code (terminal or IDE), the Claude desktop app and claude.ai on the web. What differs is whether `npm install` works, whether there is a browser to look at slides, and where the finished file must go. Find out first, with commands, rather than guessing.

## Detect

```bash
node -v; npm -v; python3 -V                      # what can run
ffmpeg -version | head -1                        # videos can be prepared (npm run media)
```

Whether you are in a chat sandbox, and where the user's files are and where results must go so they can download them, is said by that environment itself (its instructions, the paths of the files they attached). Use what it says; if nothing says it, ask the user where they want the file rather than guessing a path.

Then, in the deck folder, try the best path once with a time limit:

```bash
timeout 120 npm install --no-audit --no-fund && echo NPM_OK
```

(macOS has no `timeout` command — there, run `npm install` plainly; Claude Code on a Mac almost always has network.)

| you see | path |
|---|---|
| `NPM_OK` | **A. npm** — `npm run dev / build / preview`, the full workflow in SKILL.md |
| npm missing, or the install fails / times out (no network, registry blocked) | **B. no build** — `python3 scripts/single.py` |
| neither Python nor Node can run | **C. by hand** — see the end of this file |

Do not keep retrying a failing install, and don't install packages globally to work around it. Path B produces the same kind of file.

## The three places

**Claude Code (terminal, IDE, or a Code session in the desktop app)** — runs on the speaker's own computer.
- Create the deck folder where the user works (`./<talk-slug>/`), or where they say. Their material is on disk: read the folder they point to.
- Path A normally works. `npm run dev` opens the preview in their browser; you can ask them to look, or use a browser tool / headless Chrome if you have one.
- The result stays at `<talk-slug>/dist/<name>.html` (or `.zip`). Tell them the full path; on macOS `open dist/` shows it in Finder.

**claude.ai on the web, and chats in the desktop app** — skills run in a sandboxed Linux container.
- The skill's own files may be read-only: copy the template to a working folder first (`cp -r <skill>/assets/template /tmp/<talk-slug>` or your home folder).
- The user's attachments are wherever that environment puts uploads (see above). A zip of material: unpack it into its own folder and look at everything before planning — pictures, logos, old slides, notes.
- Network may be off or limited, so path A may fail → path B. Pillow is often installed, so B can shrink photos and (with `pillow-heif`) convert HEIC; check with `python3 -c "import PIL"`. ffmpeg may be missing: then a video cannot be prepared here — say so, and either leave it out of the zip (the speaker adds it on Wunderframe with **Add video**, after converting it on their computer) or ask them to send an MP4 that already fits.
- There is no browser for you to look at the slides. Lean on the layouts as they are (they are sized for the canvas), keep text within the limits in `design.md`, and run the checks. If `playwright` or a Chrome binary happens to exist, screenshot the built file (see "Look at the slides" below).
- **Deliver into the folder the environment names for the user's downloads** (`python3 scripts/single.py --out <that folder>` writes the deck straight there); copy the plan too (`<talk-slug>-plan.md`). Then name the files in your reply so they find them, and tell them the next step: download, then upload on their Wunderframe presenter link.

**Anywhere, when the user wants the source too** — zip the deck folder without `node_modules/` and `dist/` and deliver it next to the built file, so they (or a later session) can keep editing.

## Path B: no build — `scripts/single.py`

Python 3 standard library only (Pillow optional). It does what the Vite build does for this template:

- `<link rel="stylesheet">` → `<style>`, with `@import` and `url()` (fonts, backgrounds) inlined as `data:` URLs;
- `<script type="module" src="./src/deck.js">` → one inline module, with its relative `import`s bundled (the template's engine imports only `./wf-runtime.js`);
- pictures in `src`, `poster`, `srcset`, `style="…url()…"` → `data:` URLs; photos larger than 2560 px are shrunk, HEIC/AVIF/TIFF converted (Pillow; on a Mac, `sips` when Pillow can't read HEIC);
- videos referenced as `/media/<file>` (in `public/media/`) → a `.zip` with `index.html` + `media/…`, within the same limits as `npm run build` (zip ≤ 100 MB, page ≤ 25 MB, a video ≤ 8 MB is folded into the page);
- HTML comments are dropped; then the basic checks run, and `scripts/check.mjs` too if `node` exists.

```bash
python3 scripts/single.py                                  # → dist/<name>.html (+ .zip with videos)
python3 scripts/single.py --out <downloads folder>         # straight to where the user downloads
python3 scripts/single.py --name my-talk --max-px 1920     # name the file, smaller photos
```

`single.py` converts and shrinks pictures but does **not** re-encode videos: before it, run `node scripts/media.mjs` when Node exists (no npm packages needed), else the ffmpeg commands in `steps-and-media.md`.

What it cannot do, so don't ask it to: resolve npm packages (`import x from 'some-package'` is refused — copy the file into `src/` and import it relatively), transpile (write JavaScript that Safari 14 runs: no `.at()`, `structuredClone`, `Object.hasOwn`, top-level `await`), or run Svelte/React/Tailwind. For those decks you need path A.

`node scripts/serve.mjs` (the sealed rehearsal) needs no npm packages: if Node exists but the install failed, `npm run preview` still works on the file `single.py` built.

## Look at the slides

With a browser tool or the dev preview: open the **Slides** grid. Without one:

```bash
node scripts/shots.mjs                    # every slide, all steps shown → dist/shots-<time>/slide-NN.png
node scripts/shots.mjs --steps none       # each slide as it arrives, before the first Next
```

It finds a browser by itself (Chrome/Chromium headless — `CHROME=/path` to name one — then Playwright with the installed Chrome, then Playwright's own), checks that each picture was really written, and puts each run in a **new folder** — look only at the newest one, never at a folder another run (or another agent) wrote. No browser at all: it says so; then `npx playwright install chromium` if the network allows, or rely on the layouts and the checker.

Look at every PNG (text over the edge, text too small, empty areas, pictures badly cropped), fix, build, shoot again. The shots are not for upload.

## Path C: by hand (no Python, no Node)

Rare, but possible in a chat without code execution. Write one `.html` file directly: the template's `index.html` structure, the contents of `src/deck.css` in a `<style>`, and the minimal engine from `protocol.md` §3 (plus `data-wf-step` attributes — the screen injects the step helper itself when the page uses them). Fonts: leave them out (system font stack) and say so. Pictures: only ones you can reference as `data:` URLs or draw as inline SVG. Tell the user this file has not been checked and that **Preview and rehearse** on Wunderframe is their check.
