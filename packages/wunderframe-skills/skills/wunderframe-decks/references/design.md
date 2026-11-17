# Designing a talk that works in the hall

Read this before writing slides. A deck on Wunderframe is seen on a venue screen from 5–30 metres away while somebody talks. The speaker is the presentation; the slides are the backdrop that makes what they say easier to follow and harder to forget. Every rule below follows from that.

## Contents
1. Plan the talk before the slides
2. Structure and rhythm
3. One idea per slide — how much text
4. Type on a 1920×1080 canvas
5. Colour, contrast and brand tokens
6. Pictures, drawings, icons
7. Motion, steps and slide pictures
8. Speaker notes written for speaking
9. Timing
10. Lessons from a real talk
11. Before you hand it over

## 1. Plan the talk before the slides

Write a **plan** first and show it to the speaker — it is cheap to change, a built deck is not. One block per slide:

```markdown
## Slide 5: The problem (Not allowed in school)
ON THE SCREEN  Headline + 4 short lines, the last one "They banned him from school"
VISUAL         A school with a "no entry" sign; a small figure beside it
SAY (notes)    When people found out … / They thought a handshake was enough … / Pause: "Would that be fair?"
STEPS          4 presses, one line each, then the question
TIME           ~40 s
```

- **ON THE SCREEN** is what the audience reads. **SAY** is what the speaker says. They are different texts: if they are the same, the audience reads ahead and stops listening.
- If the speaker has a brief, a rubric or grading criteria ("explain a quote", "key terms on screen", "free speaking, keywords only"), map **every criterion to a slide** and end the plan with that checklist. It is the easiest way to show the deck does what was asked.
- If they speak from index cards, number the cards and note which cards belong to which slide ("cards 5–12 → slide 2"). Speakers keep their cards; the notes should match them.
- Material may be in another language than the talk (a German textbook for an English talk). Translate, keep the original only where it matters (a quote, a name), and put foreign or technical words **on screen** — the audience can't spell what it only hears.
- Facts the speaker might be asked about: note them in the plan with where they came from ("book p. 48"), and flag anything you are unsure of for the speaker to check — they will be the one answering questions.

## 2. Structure and rhythm

A shape that works for most talks of 5–30 minutes:

| part | slides | why |
|---|---|---|
| Opening: title + who + why it matters | 1–2 | the room decides in the first minute whether to listen |
| Words / context the audience needs | 0–1 | a key-terms slide early saves explaining mid-story |
| The story or argument, in 2–4 parts | most | each part: a divider or a clear headline, then 1–4 slides |
| The turn: the point, the quote, the number | 1–2 | the slide people photograph |
| What it means / what to do / what I think | 1 | the take-away, said in the speaker's own voice |
| Close: thank you + questions | 1 | likely questions and short answers go in the notes |

Rhythm matters more than any single slide. Alternate dense and sparse: a slide with three points, then a slide with one huge number; a diagram, then a full picture; never the same layout three times in a row. Section dividers (`.divider`) give the room a breath and the speaker a visible "we are here".

Slide count: about **1 slide per minute** for a conference talk; short talks (school, pitches, lightning talks) run faster, **20–40 seconds per slide** — a 5-minute talk is 9–12 slides. More than that and the speaker rushes; fewer and one slide sits on screen while three things are said.

Offer the speaker a choice when the structure is not obvious — 2 or 3 arcs in a sentence each (chronological story / problem → turn → impact / three lessons), with a recommendation.

## 3. One idea per slide — how much text

- **The headline is the point**, not a label: "Gail became his mother", not "Family". One word in it can carry the accent colour (`<span class="hl">`) — the word you'd stress when saying it.
- A small **kicker** above it (`.kicker`) says where we are in the talk ("Part 2 · The problem"). It replaces a separate agenda slide in short talks.
- At most **4 lines** of body per slide, each **≤ 8 words**. If it needs more, it is two slides, or it belongs in the notes.
- No full sentences the speaker will say anyway. Keywords and short phrases; **bold** (accent) for the one word per line that matters.
- One big thing per slide: a number (`.statement .big`), a quote, a picture, a diagram. Not two.
- Sources and fine print at `--fs-tiny` at the bottom — or on the last slide.

## 4. Type on a 1920×1080 canvas

The canvas is scaled as a whole to the screen, so design in canvas pixels. Rough test: shrink the slide to 320 px wide (the remote's slide grid does this); if you can still read the body text, the back row can too.

| role | size (canvas px) | token |
|---|---|---|
| one huge number / word | 200–300 | `--fs-display` |
| title slide | 130–200 | `--fs-h1` |
| slide headline | 76–96 | `--fs-h2` |
| card / step heading | 44–56 | `--fs-h3` |
| body, bullets | 40–54 | `--fs-body` |
| secondary line, explanation | 32–36 | `--fs-small` |
| sources, footer — the floor | 26–28 | `--fs-tiny` |

- **Nothing under 26 px**, and nothing that matters under 32 px.
- **Ship the fonts.** A deck without `@font-face` uses whatever the screen has — "Avenir Next" on the lectern Mac, something else on the TV box, and the line breaks move. The template inlines Inter and JetBrains Mono (variable, all weights, latin + latin-ext). Brand font: copy its `.woff2` into `src/fonts/` and add an `@font-face` in `fonts.css`.
- Two families at most (one text, one accent such as a mono for kickers, or a serif for quotes). Weights do the hierarchy: 800–850 headlines, 600–750 emphasis, 400 body.
- Tight letter-spacing on big headlines (−0.02 to −0.035 em), normal on body, wide (+0.12–0.2 em) on small uppercase kickers.
- Line length ≤ ~40 characters for headlines, ≤ ~60 for body. Use `max-width`, not `<br>`.
- Numbers that change or line up: `font-variant-numeric: tabular-nums`.

## 5. Colour, contrast and brand tokens

All colour lives in the tokens at the top of `src/deck.css`. Change those, not the layouts.

- **Brand mapping**: `--accent` = the brand's main colour (kickers, highlights, callouts, the timeline dots); `--bg`/`--bg-2`/`--stage-bg` = the brand's dark (or light) base; `--ink`/`--muted` = text. A brand with several colours: map them to `--good` / `--bad` / `--info` and **give each a meaning** that holds all talk long (e.g. coral = the problem, green = what helped, blue = facts). Colour that means something is remembered; colour as decoration is noise.
- **Contrast**: body text ≥ 7:1 against the background, headlines ≥ 4.5:1. Venue screens lose contrast (projectors wash out, LED walls are viewed at an angle, rooms are lit). `--dim` is for sources and captions only, never for content.
- **Dark or light?** Dark backgrounds suit LED walls, TVs and dim halls, and they hide the edges of the letterbox. A projector in a bright room turns black into grey — use `<html data-theme="light">` there. Ask the speaker if they know the room.
- Text on a picture: put it on a gradient (`.bleed .caption`) or a solid card, never directly on a busy photo.
- Background: a static gradient with soft glows (`--stage-bg`). No animated blurred blobs: a large `filter: blur()` that moves forever costs an old TV box its frame rate and shimmers on LED walls.
- Don't carry meaning by colour alone — add an icon or a word (✓/✗, "before"/"after").

## 6. Pictures, drawings, icons

- **The speaker's own material beats stock.** Their photos, their drawings, the page from their book, their product. It is personal and the audience notices.
- **Photos of paper** (a drawing, a handout, a book page photographed on a table): crop to the paper, then frame it as an object — `figure.paper` gives it a white mat, a shadow and a slight tilt (`--tilt`). Don't run a phone photo of a sheet of paper full-bleed: the table, the shadow and the lens distortion show.
- **Faces**: `figure.portrait` crops round; set `object-position` so the face sits in the circle.
- **Full-bleed photos** (`.bleed`): ≥ 1920 px wide, subject away from where the caption goes.
- **HEIC** (iPhone photos) cannot be shown by any screen — they are converted to JPEG before every build (`npm run media`; `scripts/single.py` on path B). Phone videos the same: re-encoded to a small MP4 with ffmpeg (`references/steps-and-media.md`).
- Size: 2560 px on the long side is plenty; JPEG q≈80. A picture used on two slides is inlined twice — fine for a few, wasteful for many large ones.
- **Icons**: inline SVG (`<symbol>` sprite in `index.html`, `<svg class="icon"><use href="#i-star"/></svg>`). One style (all filled or all outlined), coloured by `currentColor`. **No emoji** on slides: they render differently per device and old screens may lack a colour emoji font.
- **Diagrams** instead of bullet lists where there is a sequence or a cause: `ol.timeline` for dates, `.flow` for "this led to that", `.cards` for options side by side, `dl.terms` for a glossary.

## 7. Motion, steps and slide pictures

Two kinds of reveal, for two jobs:

- **Steps** (`data-wf-step`) — the speaker presses Next and the next thing appears. Use them for **anything the speaker talks through**: list items, the punchline after the number, the boxes of a flow, the answer after the question. The audience reads what the speaker is on, not three lines ahead. ≤ 5 steps per slide; write the count in the notes ("4 presses").
- **Entrances** (`class="enter" style="--d:.2"`) — things that arrive with the slide by themselves: the headline, a picture settling in. Decoration, never content the speaker waits for.

Hard rules — each one is a way decks broke on stage:

- **Keep entrances short: everything settled within ~0.8 s.** The remote's slide pictures (the speaker's preview of current and next slide, the slide grid) are photographed about **1 s after the slide arrives, without the step helper**. Anything still on its way is missing from that picture, and the audience waits through a 5-second choreography on every slide. A timed sequence that runs 4 s is a sequence of steps that should be pressed. `npm run preview` → **Slides** shows the pictures exactly that way; the checker warns about long delays.
- **Never hide steps in CSS** and never start a whole slide at `opacity: 0` (see `steps-and-media.md`).
- **Deterministic.** Every screen in a room runs its own copy of the deck. `Math.random()` for particle positions means each screen of a video wall shows something different. Fixed positions, fixed delays.
- **No counting animations for numbers that matter** (1900 → 1989): the slide picture catches a random year. Show the final number; if it must move, it must finish within the 0.8 s.
- **Endless ambient animation** (floating shapes, spinning rays, bobbing pictures): at most one subtle one per slide, `transform`/`opacity` only, and gone under `prefers-reduced-motion`. It looks alive on a laptop and stutters on a TV box.
- Slide transitions: short motion (≤ 0.5 s), never a fade from black.

## 8. Speaker notes written for speaking

Notes go to the phone, the lectern and the prompter (`references/presenting.md`).

- **Keywords and short sentences, not a script** — unless the speaker asks for a script. People glance at notes; they don't read them. "Free speaking" (a common school criterion) means keywords.
- First line = the cue for the first thing to say. Last line = the transition: "→ next: the numbers".
- Stage directions in the notes, short: "Pause.", "Look at the room.", "Ask: Would that be fair?", "Slow down, speak quietly." They are what speakers forget under pressure.
- The press count when the slide has steps: "3 presses: one date each".
- Each `<p>` is its own block on the prompter. 3–6 blocks per slide; ≤ 4000 characters (the protocol limit).
- The last slide's notes: the **likely questions with one-line answers**. Speakers dread questions; this is where a deck helps most.
- Notes in the speaker's language, even if the slides are in another.

## 9. Timing

Put a timing line in the plan ("Slides 1–2 → 45 s · 3–4 → 45 s · …") and check the sum against the slot, minus 10–20 % for nerves, pauses and the room. Notes that take longer than the slide's time to say are too long. If the speaker must cut, cut slides, not words per slide.

## 10. Lessons from a real talk

A 5-minute school talk about a historical figure, built from a textbook page, 32 handwritten index cards and two of the student's drawings, delivered in English from German material. It was made **before Wunderframe had steps, web-video players or this template** — so its timed animations were the only way to reveal things then, not a mistake. What carries over — generalised:

- **The plan file was the most useful artefact.** ON THE SCREEN / VISUAL / SAY per slide, a mapping of the grading criteria to slides, a card-to-slide map and a timing table. The speaker could rehearse from it before a single slide existed.
- **The speaker's drawings made the deck.** Framed as paper (white mat, tilt, shadow) on the title and the quote slide, cropped round on the "why he's my hero" slide. Stock pictures would have been forgettable.
- **A key-terms slide early** (four medical words + "activist", each with an icon and a one-line meaning) carried a criterion ("key terms on screen") and saved explanations later.
- **Diagrams instead of bullets**: a timeline for the life dates, a three-box flow (speaks up → news spreads → kids can go to school), a numbered list for the problem, ending in a pill-shaped question to the room ("Would that be fair?").
- **The quote slide** paired the original drawing with the translated quote and a "what it means" card — the criterion was "present a quote *and explain it*".
- **Likely questions** with short answers sat in the last slide's notes.
- **What the template now does for you** that this deck had to do by hand: one HTML file with everything inlined (also without npm, `scripts/single.py`), fonts shipped (it used system fonts, which look different on every device), HEIC photos converted before the build, `data-notes` read as notes. Where it timed its reveals (up to 5 s per slide), use **steps** today: the speaker sets the pace and the remote's slide pictures show complete slides. Fixed positions instead of `Math.random()` particles, no large animated blurs (old TV boxes stutter). The building blocks it invented — `.paper`, `.portrait`, `.terms`, `.timeline`, `.flow`, `.callout` — are in the template.

## 11. Before you hand it over

Look at the whole deck at once (the preview's **Slides** grid, or screenshots) and check:

- [ ] Every slide has one point, and its headline says it.
- [ ] Nothing under 26 px; body ≥ 40 px; no text runs into the edge or off the slide.
- [ ] No two neighbouring slides with the same layout; something big every few slides.
- [ ] Every slide has notes; slides with steps say how many presses.
- [ ] The slide pictures (built preview → Slides) show complete slides.
- [ ] Brand colours used with consistent meanings; contrast holds on a washed-out screen.
- [ ] The criteria / brief are all covered (if there was one), and the timing adds up.
- [ ] The last slide's notes have likely questions and answers.
