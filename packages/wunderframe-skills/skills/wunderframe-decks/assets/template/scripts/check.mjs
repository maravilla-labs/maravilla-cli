#!/usr/bin/env node
/**
 * Will this deck play on a Wunderframe screen? Static checks on a built file.
 *
 *   node scripts/check.mjs [dist/<name>.html]     (npm run build runs it for you)
 *
 * Works on any HTML deck, not only ones made from this template (a reveal.js
 * export, a hand-written file …). Exit code 1 when something will break.
 */
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MB = 1024 * 1024;

/** Does this MP4/MOV put its `mdat` (the media) before its `moov` (the index)? Reads only box headers. */
async function moovAfterMdat(file) {
	const fh = await open(file, 'r');
	try {
		const size = (await fh.stat()).size;
		const head = Buffer.alloc(16);
		for (let at = 0, n = 0; at + 8 <= size && n < 64; n++) {
			await fh.read(head, 0, 16, at);
			let len = head.readUInt32BE(0);
			const type = head.toString('latin1', 4, 8);
			if (type === 'moov') return false;
			if (type === 'mdat') return true;
			if (len === 1) len = Number(head.readBigUInt64BE(8));
			else if (len === 0) return false;
			if (len < 8) return false;
			at += len;
		}
		return false;
	} finally {
		await fh.close();
	}
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let file = process.argv[2];
if (!file) {
	const dist = path.join(root, 'dist');
	const htmls = existsSync(dist) ? (await readdir(dist)).filter((f) => f.endsWith('.html')) : [];
	if (!htmls.length) {
		console.error('No built deck in dist/ — run `npm run build`, or pass a file.');
		process.exit(1);
	}
	file = path.join(dist, htmls[0]);
}
const raw = await readFile(file, 'utf8');
const bytes = Buffer.byteLength(raw);
const html = raw.replace(/<!--[\s\S]*?-->/g, ''); // commented-out markup never plays

const errors = [];
const warns = [];
const infos = [];

// Size
if (bytes > 25 * MB) errors.push(`The file is ${(bytes / MB).toFixed(1)} MB — Wunderframe takes 25 MB. Compress pictures, move videos to public/media.`);
else if (bytes > 15 * MB) warns.push(`The file is ${(bytes / MB).toFixed(1)} MB — old screens download it slowly; compress pictures if you can.`);

// Protocol
const speaks = /wf\s*(?:===?|:)\s*['"]deck['"]/.test(html) && /postMessage/.test(html);
if (!speaks) errors.push('The deck does not speak the Wunderframe deck protocol (no wf:"deck" messages): the remote cannot drive it.');
else if (!/ready\s*:\s*(?:true|!0)/.test(html) && !/\bready\b/.test(html)) warns.push('No `ready: true` state found: a screen that reloads will not be put back on the right slide.');

// Network references — a screen frame cannot fetch anything
const ext = new Set();
for (const m of html.matchAll(/<(\w+)\b[^>]*?\s(src|href|poster|data-src|srcset)\s*=\s*["']\s*((?:https?:)?\/\/[^"'\s]+)/gi)) {
	const [, tag, attr, url] = m;
	if (tag.toLowerCase() === 'a') continue; // a link is fine
	if (tag.toLowerCase() === 'link' && /preconnect|dns-prefetch/.test(m[0])) continue;
	ext.add(`<${tag} ${attr}> ${url}`);
}
for (const m of html.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) ext.add(`css url() ${m[1]}`);
for (const m of html.matchAll(/@import\s+(?:url\()?\s*["']?((?:https?:)?\/\/[^"')\s;]+)/gi)) ext.add(`@import ${m[1]}`);
for (const e of ext) {
	if (/youtube|youtu\.be|vimeo/.test(e)) {
		if (/^<iframe /i.test(e)) continue; // a YouTube / Vimeo player: the screen draws it (checked below)
		warns.push(`Web video ${e} — only a YouTube / Vimeo <iframe> is played by the screen; download it and use a file.`);
	}
	else errors.push(`Loaded from the network, will be missing on a screen: ${e} — inline it (or upload a .zip; Wunderframe folds https files in at upload).`);
}
if (/\bfetch\s*\(|XMLHttpRequest|import\s*\(\s*["'`]http/.test(html))
	warns.push('The page requests data at runtime (fetch / XHR / dynamic import). On a screen this works only online and with CORS for Origin: null; slide pictures and offline screens get nothing — make sure every slide looks right without it.');
const WEB_VIDEO = /(?:https?:)?\/\/(?:[a-z0-9-]+\.)*(?:youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com)\//i;
for (const f of html.match(/<iframe\b[^>]*>/gi) || []) {
	const src = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(f)?.[1] || '';
	if (WEB_VIDEO.test(src)) {
		if (!/\bdata-wf-play\b/.test(f) && !/[?&]autoplay=1\b/.test(src))
			warns.push(`Web video ${src} has no data-wf-play: the screen shows its player, but nobody can press play on a screen — add data-wf-play so Next starts it.`);
		else infos.push(`Web video ${src}: the screen draws the player and Next starts it — needs internet on the screen, nothing of it is kept on the device.`);
	} else warns.push(`The page embeds an <iframe> (${src || 'inline'}): web pages inside it will not load offline.`);
}
if (/localStorage|sessionStorage|indexedDB/.test(html))
	warns.push('The page uses browser storage: the sealed frame has none — wrap it in try/catch.');

// Fonts
const faces = [...html.matchAll(/@font-face\s*{[^}]*}/g)].map((m) => m[0]);
const badFaces = faces.filter((f) => /url\(/.test(f) && !/url\(\s*["']?data:/.test(f));
if (badFaces.length) errors.push(`${badFaces.length} @font-face rule(s) point at files, not data: URLs — the screen falls back to system fonts.`);
if (!faces.length) infos.push('No @font-face: the deck uses the screen’s system fonts (looks different per device).');

// Pictures
if (/data:image\/avif|\.avif\b/.test(html)) warns.push('AVIF pictures: Safari 14 / older WebViews cannot show them — use WebP, JPEG or PNG.');
if (/data:image\/hei[cf]|\.hei[cf]\b/i.test(html)) errors.push('HEIC/HEIF pictures (iPhone photos): browsers cannot show them — convert to JPEG (macOS: sips -s format jpeg in.heic --out out.jpg).');
for (const m of html.matchAll(/data:image\/(\w+)[^,]*,([A-Za-z0-9+/=]{2800000,})/g))
	warns.push(`A ${m[1]} picture of ~${((m[2].length * 0.75) / MB).toFixed(1)} MB is inlined — compress it (2560 px wide is plenty).`);

// Videos
const media = [...new Set([...html.matchAll(/["'(\s]media\/([^"'()\s?#<>]+)/g)].map((m) => m[1]))];
for (const ref of media) {
	const f = path.join(root, 'public', 'media', decodeURIComponent(ref));
	if (/\.(webm|mov)$/i.test(ref)) infos.push(`media/${ref}: Wunderframe makes a 720p MP4 copy of WebM/MOV — export MP4 (H.264 + AAC) for full quality.`);
	else if (!/\.(mp4|m4v)$/i.test(ref)) warns.push(`media/${ref}: not MP4 — convert to MP4 (H.264 + AAC) before uploading.`);
	if (existsSync(f) && (await stat(f)).size > 1024 * MB) errors.push(`media/${ref} is over 1 GB — Wunderframe takes up to 1 GB per video.`);
	if (existsSync(f) && /\.(mp4|m4v|mov)$/i.test(ref) && (await moovAfterMdat(f)))
		warns.push(`media/${ref} keeps its index at the end (no "faststart"): a screen that streams it shows nothing until the whole file is loaded. Fix: ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`);
}
const videos = [...html.matchAll(/<video\b[^>]*>/gi)].map((m) => m[0]);
for (const v of videos) {
	if (!/\bmuted\b/.test(v) && !/\bdata-wf-play\b/.test(v)) warns.push('A <video> without `muted` may refuse to autoplay; add muted (the remote’s sound button unmutes it).');
	if (!/\bposter\s*=/.test(v)) infos.push('A <video> has no poster: until it plays (or before its file is added) the slide shows a dark box.');
	if (!/\bplaysinline\b/.test(v)) infos.push('Add `playsinline` to <video> — iOS-based screens go fullscreen otherwise.');
}

// Motion — the remote's slide pictures are photographed about 1 s after a slide arrives
const secs = (n, u) => (u === 'ms' ? n / 1000 : n);
let latest = 0;
for (const m of html.matchAll(/animation-delay\s*:\s*(\d*\.?\d+)(ms|s)\b/g)) latest = Math.max(latest, secs(+m[1], m[2]));
for (const m of html.matchAll(/animation\s*:[^;{}]*?(\d*\.?\d+)(ms|s)\b[^;{}]*?(\d*\.?\d+)(ms|s)\b/g)) latest = Math.max(latest, secs(+m[3], m[4]));
if (/calc\(\s*var\(--d\b/.test(html)) for (const m of html.matchAll(/--d\s*:\s*(\d*\.?\d+)/g)) latest = Math.max(latest, +m[1]);
if (latest > 1)
	warns.push(`Something starts animating ${latest} s after its slide arrives. The remote's slide pictures are taken about 1 s after arrival, so it is missing there (and the audience waits for it) — keep entrances under ~0.8 s, or make it a step (data-wf-step) the speaker presses for.`);
if (/Math\.random\s*\(/.test(html))
	warns.push('The page uses Math.random(): every screen of a room (each panel of a video wall) runs its own copy, so random layouts differ between screens. Use fixed values.');
if (/filter\s*:\s*blur\(\s*(?:[3-9]\d|\d{3,})px/.test(html) && /\binfinite\b/.test(html))
	infos.push('Large blur filters plus endless animations: old TV boxes and lectern Macs may stutter — prefer static gradients for backgrounds.');

// Newer than Safari 14 (the build does not polyfill)
const modern = [
	[/[\w\])]\.at\(/, 'Array/String .at()'],
	[/\bstructuredClone\s*\(/, 'structuredClone()'],
	[/\bObject\.hasOwn\s*\(/, 'Object.hasOwn()'],
	[/\.findLast(?:Index)?\s*\(/, '.findLast()'],
	[/\.to(?:Sorted|Reversed|Spliced)\s*\(/, '.toSorted()/.toReversed()'],
	[/:has\(/, 'CSS :has() (the whole rule is dropped)'],
	[/color-mix\(/, 'CSS color-mix() (the declaration is dropped)'],
	[/@container\b/, 'CSS container queries']
].filter(([re]) => re.test(html)).map(([, what]) => what);
if (modern.length) warns.push(`Not in Safari 14 (old lectern Macs / TV boxes): ${modern.join(', ')} — use an older equivalent or a polyfill.`);

// Slides & notes (template decks: <section> + <aside class="notes"> or data-notes="…")
const sections = (html.match(/<section\b/gi) || []).length;
const notes = (html.match(/class\s*=\s*["'][^"']*\bnotes\b|\sdata-notes\s*=\s*["']\s*[^\s"']/gi) || []).length;
if (sections) infos.push(`${sections} slides, ${notes} with speaker notes.`);
if (sections && notes < sections) warns.push(`${sections - notes} slide(s) without speaker notes — the prompter is empty there. Add <aside class="notes"> (or data-notes) with what to say.`);
// Titles: the remote's slide list shows them — the template's own labels mean nothing to the speaker.
const GENERIC = new Set(['…', '...', 'title', 'slide', 'part 1', 'context', 'the number', 'options', 'demo video', 'timeline', 'cause and effect', 'words to know', 'the quote', 'why it matters to me']);
const titles = [...html.matchAll(/<section\b[^>]*\sdata-title\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1].trim());
const generic = [...new Set(titles.filter((t) => !t || GENERIC.has(t.toLowerCase())))];
if (generic.length) warns.push(`Slide title(s) left from the template or empty: ${generic.map((t) => `"${t}"`).join(', ')} — give every slide a data-title that says what it is (the remote's slide list shows it).`);
const dup = [...new Set(titles.filter((t, i) => t && titles.indexOf(t) !== i))];
if (dup.length) warns.push(`Several slides share a title: ${dup.map((t) => `"${t}"`).join(', ')} — the speaker cannot tell them apart in the slide list.`);
const steps = (html.match(/<[a-z][^<>]*\sdata-wf-step\b/gi) || []).length;
const plays = (html.match(/<video\b[^<>]*\sdata-wf-play\b/gi) || []).length;
if (steps || plays) infos.push(`${steps} step(s), ${plays} video step(s).`);

// Report
const out = (sym, list) => list.forEach((l) => console.log(`  ${sym} ${l}`));
console.log(`\nChecking ${path.relative(process.cwd(), file)} (${(bytes / MB).toFixed(2)} MB)`);
out('✗', errors);
out('!', warns);
out('·', [...new Set(infos)]);
if (!errors.length) console.log(`  ✓ ready for Wunderframe${warns.length ? ' (see warnings)' : ''} — rehearse it with \`npm run preview\``);
process.exit(errors.length ? 1 : 0);
