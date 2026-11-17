# Wunderframe Agent Skills

AI agent skills for [Wunderframe](https://www.wunderframe.com) — event screens, live shows and presenters. Works with Claude Code, Cursor, GitHub Copilot and other AI coding tools.

## Install

```bash
npx skills add maravilla-labs/maravilla-cli/packages/wunderframe-skills
```

## Skills

| Skill | Description |
|-------|-------------|
| **wunderframe-decks** | Make a talk/presentation for Wunderframe, guided: it asks about the audience, goal and material (outlines, scripts, pictures, old slides), proposes a structure and a per-slide plan, then builds an HTML deck on a 1920×1080 canvas with design guidance for big rooms, speaker notes for the remote and prompter, build-up steps (`data-wf-step`), videos and YouTube/Vimeo players that start on Next (`data-wf-play`), built fully offline into one HTML file or a zip. Works in Claude Code, the Claude desktop app and claude.ai: with npm (Vite + `vite-plugin-singlefile`, live preview that behaves like a Wunderframe screen and the presenter's remote) or without (a Python script builds the same file). Ships a starter template with layouts and building blocks, fonts as files, and a checker for the size / offline / protocol / slide-picture rules. |

## What the skill relies on in Wunderframe

The deck protocol v1 (`postMessage`, `wf: 'deck'`) and the step helper (`data-wf-step`, `data-wf-play`, web-video `embeds`). The template's `src/wf-runtime.js` is a verbatim copy of the helper in Wunderframe's `src/lib/deck-runtime.ts` — when that changes, copy it again.

## Claude desktop / claude.ai and ChatGPT

These apps take a skill as a ZIP of its folder (Claude: *Customize › Skills › + › Create skill › Upload a skill*, with *Code execution* on; ChatGPT workspaces with Skills: *Skills › Create › Upload from your computer*). Wunderframe serves the ready ZIP at `https://www.wunderframe.com/skills/wunderframe-decks.zip`, linked from the docs page *Present your own deck*. After changing the skill, rebuild that file in the Wunderframe repo:

```bash
cd packages/wunderframe-skills/skills
zip -r -X <wunderframe>/static/skills/wunderframe-decks.zip wunderframe-decks \
  -x "wunderframe-decks/evals/*" "*.DS_Store" "*/node_modules/*" "*/dist/*" "*/originals/*"
```
