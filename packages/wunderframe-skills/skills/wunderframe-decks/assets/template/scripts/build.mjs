#!/usr/bin/env node
/**
 * Build the deck for Wunderframe.
 *
 *   npm run build
 *     → dist/<name>.html   one self-contained file (upload this when the deck has no videos)
 *     → dist/<name>.zip    index.html + media/… (upload this when the deck has videos)
 *     first prepares pictures and videos (scripts/media.mjs), then runs the checks (scripts/check.mjs).
 *
 * Wunderframe limits (spec "Presenting an uploaded deck" / "Videos in a deck"):
 *   HTML file ≤ 25 MB · zip ≤ 40 MB · a video ≤ 8 MB inside a zip is folded into the page
 *   (base64, +33 %), a bigger one is kept as a library video · a video left out of the zip
 *   becomes a slot you fill with "Add video" (≤ 1 GB, MP4 H.264/AAC best) after uploading.
 */
import { build } from 'vite';
import { readFile, writeFile, stat, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const MB = 1024 * 1024;
const HTML_MAX = 25 * MB;
const ZIP_MAX = 40 * MB;
const INLINE_MAX = 8 * MB;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const name = (pkg.name || 'deck').replace(/^@[^/]+\//, '');
const dist = path.join(root, 'dist');

// Pictures and videos first: HEIC → JPEG, oversized photos shrunk, videos → small streamable MP4 (ffmpeg).
const prep = spawnSync(process.execPath, [path.join(root, 'scripts', 'media.mjs')], { stdio: 'inherit' });
if (prep.status !== 0) {
	console.error('\nFix the pictures/videos above first (npm run media), then build again.');
	process.exit(1);
}

await build({ root, logLevel: 'warn' });

let html = await readFile(path.join(dist, '.vite', 'index.html'), 'utf8');
// Author comments (commented-out slides, hints) do not go on stage.
html = html.replace(/<!--[\s\S]*?-->/g, '');
// Videos live in public/media and are referenced as "/media/x.mp4"; inside the zip they are "media/x.mp4".
// (Vite may emit "/media/…" or "./media/…" depending on its base.)
html = html.replace(/(["'(=\s])\.?\/media\//g, '$1media/');
await mkdir(dist, { recursive: true });
await rm(path.join(dist, `${name}.zip`), { force: true });
const htmlFile = path.join(dist, `${name}.html`);
await writeFile(htmlFile, html);
const htmlBytes = Buffer.byteLength(html);

// ── videos and other media the page names ──────────────────────────────────
const refs = [...new Set([...html.matchAll(/["'(\s]media\/([^"'()\s?#<>]+)/g)].map((m) => decodeURIComponent(m[1])))];
const media = [];
for (const ref of refs) {
	const file = path.join(root, 'public', 'media', ref);
	media.push({ ref, file, bytes: existsSync(file) ? (await stat(file)).size : null });
}

const fmt = (b) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
console.log(`\n${path.relative(root, htmlFile)}  ${fmt(htmlBytes)}${htmlBytes > HTML_MAX ? '  ✗ over 25 MB' : ''}`);

if (media.length) {
	const entries = { 'index.html': [strToU8(html), { level: 9 }] };
	let zipBytes = htmlBytes;
	let inlineBudget = HTML_MAX - htmlBytes;
	const inZip = [];
	const addLater = [];
	const missing = media.filter((m) => m.bytes === null);
	for (const m of media.filter((m) => m.bytes !== null).sort((a, b) => a.bytes - b.bytes)) {
		const folds = m.bytes <= INLINE_MAX;
		const fits = zipBytes + m.bytes <= ZIP_MAX && (!folds || m.bytes * 1.34 <= inlineBudget);
		if (!fits) {
			addLater.push(m);
			continue;
		}
		entries[`media/${m.ref}`] = [new Uint8Array(await readFile(m.file)), { level: 0 }];
		zipBytes += m.bytes;
		if (folds) inlineBudget -= m.bytes * 1.34;
		inZip.push({ ...m, folds });
	}
	const zipFile = path.join(dist, `${name}.zip`);
	await writeFile(zipFile, zipSync(entries));
	const realZip = (await stat(zipFile)).size;
	console.log(`${path.relative(root, zipFile)}  ${fmt(realZip)}  ← upload this one (the deck has media)`);
	for (const m of inZip)
		console.log(`  ✓ media/${m.ref}  ${fmt(m.bytes)}  ${m.folds ? 'folded into the page' : 'kept as a library video'}`);
	for (const m of addLater)
		console.log(`  ↑ media/${m.ref}  ${fmt(m.bytes)}  NOT in the zip (limits) — after uploading, "Add video" → choose this file`);
	for (const m of missing)
		console.log(`  ✗ media/${m.ref}  missing from public/media/ — the screen shows only its poster until you "Add video"`);
} else {
	console.log('  no videos → upload the .html file');
}

// ── checks ─────────────────────────────────────────────────────────────────
const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check.mjs'), htmlFile], { stdio: 'inherit' });
process.exit(r.status ?? 0);
