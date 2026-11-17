# What the speaker gets on stage

Use this to explain to a speaker how they will run the talk, and to write notes and steps that suit the remote.

## Upload and rehearse

- Presenter link → *How will you present?* → **Upload my presentation** → **Upload** (HTML ≤ 25 MB, zip ≤ 40 MB; PDF/.pptx ≤ 150 MB are converted to static slides). The organizer can do the same on the session page, or put a deck on any screens at once with **Present now**.
- After upload Wunderframe photographs every slide (1920×1080, all steps shown) for the remote's slide pictures and grid — up to 200 slides. A slide that animates is captured about a second after it arrives.
- Under the deck: the bundling report for a zip (files folded in, anything missing), **Videos in this presentation**, **Preview and rehearse** (full screen, same frame as the screens, hand signs on this device's camera, *My slides* / *Full sequence* with the speaker intro and what follows, notes *below* or *left* like a prompter). **Replace** uploads a new version; screens switch and stay on the current slide. **Download** returns the file as uploaded.

## The remote (phone, tablet, laptop, or the room's lectern)

- Shows the slide on screen and the next one (pictures), the slide number and "step n of m", the notes, Back/Next, a talk clock, **Slides** (G) to jump anywhere, a sound button for the deck's videos, and whether the deck is actually on a screen ("On 2 screens · slide 3 of 12").
- Keys and clickers: → ↓ PageDown Space Enter = next; ← ↑ PageUp Backspace = back; Home/End; T prompter; + / − text size; S scroll.
- **Prompter** (T): the notes large, white on black, adjustable size, even scroll at ¼×–5× with **Auto** (starts 1.5 s after each slide), **Mirror** for teleprompter glass.

Writing notes for this: put the *spoken* version in notes, short paragraphs (each `<p>` is its own block), keywords first, the transition to the next slide last ("→ the numbers"). Mention steps the slide has ("3 presses"). Avoid long walls of text — the prompter scrolls, but the speaker glances.

## Hands free

- **Fingertip taps** (default; camera within a few metres, e.g. a laptop or phone on the lectern): thumb to index fingertip = next, thumb to middle fingertip = back, either hand.
- **Hand signs** (camera across the stage): whole-hand signs held ~0.5 s; default right index up = next, left index up = back; ready-made sets or their own, chosen once and kept for every talk.
- **Laser pointer**: with taps, point the index finger (others curled) and hold; with signs, both fists on/off. The red dot appears on the remote and every screen of the room — on a **16:9** slide. While it is on, Next/Back wait.

## Robustness the deck must support

- A screen that restarts mid-talk loads the deck at slide 1 and reports `ready`; the remote sends it back. The template does this; the preview's **Reload screen** tests it.
- Several screens in a room (and every panel of a video wall) each run their own copy of the deck and receive the same commands — so the deck must be deterministic: no random choices, no timers that change slides, no state from storage.
- Videos are pre-loaded onto the screens from the moment backstage opens; the deck page itself is fetched when the session starts.
