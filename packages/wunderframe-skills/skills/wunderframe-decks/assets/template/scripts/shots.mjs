#!/usr/bin/env node
/**
 * Every slide of the built deck as a 1920×1080 PNG — to LOOK at the slides when there is no
 * browser to click through (and to check them before handing over).
 *
 *   npm run shots                      (after npm run build)
 *   node scripts/shots.mjs [dist/<name>.html] [--out folder] [--steps none]
 *
 * By default every step is shown, like the remote's slide pictures (the step helper is switched
 * off). --steps none: the slide as it arrives, before the first Next.
 *
 * It needs a browser, and uses the first that works: Chrome/Chromium in headless mode (CHROME=…
 * to point at one), then Playwright with the installed Chrome (`--channel chrome`), then
 * Playwright's own browser. Each picture is checked to exist — a tool that "succeeds" without
 * writing a file does not count — and each attempt is cut off after 45 s.
 * The pictures go to a NEW folder each run (dist/shots-<time>/): never look at an older run's.
 */
import { readdir, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv.splice(i, 2)[1] : null;
};
const outArg = opt('--out');
const steps = opt('--steps') ?? 'all';

let file = argv[0];
if (!file) {
	const dist = path.join(root, 'dist');
	const htmls = existsSync(dist) ? (await readdir(dist)).filter((f) => f.endsWith('.html')) : [];
	if (!htmls.length) {
		console.error('No built deck in dist/ — run `npm run build` first, or pass the file.');
		process.exit(1);
	}
	file = path.join(dist, htmls[0]);
}
const html = await readFile(file, 'utf8');
const count = (html.match(/<section\b/gi) || []).length;
if (!count) {
	console.error(`${file}: no <section> slides found.`);
	process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.resolve(outArg ?? path.join(path.dirname(file), `shots-${stamp}`));
await mkdir(out, { recursive: true });

// The page to photograph: with all steps in, the helper is kept from running (as for the slide pictures).
const page = path.join(out, 'deck.html');
await writeFile(
	page,
	steps === 'none' ? html : html.replace(/<head\b[^>]*>/i, (h) => `${h}<script>window.__wfDeck={sync:function(){}}</script>`)
);
const url = (n) => `${pathToFileURL(page).href}#${n}`;

const which = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).stdout?.split('\n')[0]?.trim() || null;
const chrome =
	process.env.CHROME ||
	[
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
	].find((p) => existsSync(p)) ||
	which('google-chrome') ||
	which('google-chrome-stable') ||
	which('chromium') ||
	which('chromium-browser');
const npx = which('npx');

const written = async (p) => existsSync(p) && (await stat(p)).size > 1000;
const attempt = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 45_000, killSignal: 'SIGKILL' });

const ways = [];
if (chrome)
	ways.push({
		name: `headless Chrome (${path.basename(chrome)})`,
		shot: (n, png) =>
			attempt(chrome, [
				'--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
				`--user-data-dir=${path.join(out, '.chrome')}`, '--window-size=1920,1080',
				'--virtual-time-budget=2500', '--run-all-compositor-stages-before-draw',
				`--screenshot=${png}`, url(n)
			])
	});
if (npx) {
	const pw = (extra) => (n, png) =>
		attempt(npx, ['--yes', 'playwright', 'screenshot', ...extra, '--viewport-size', '1920,1080', '--wait-for-timeout', '1200', url(n), png]);
	ways.push({ name: 'Playwright with the installed Chrome', shot: pw(['--channel', 'chrome']) });
	ways.push({ name: 'Playwright (its own browser)', shot: pw([]) });
}
if (!ways.length) {
	console.error('No browser found to take pictures with. Install Google Chrome (or set CHROME=/path/to/chrome), or `npx playwright install chromium`.');
	process.exit(1);
}

// Find a way that works on slide 1, then use it for all.
let way = null;
for (const w of ways) {
	const png = path.join(out, 'slide-01.png');
	w.shot(1, png);
	if (await written(png)) {
		way = w;
		break;
	}
}
if (!way) {
	console.error(`None of these could take a picture: ${ways.map((w) => w.name).join(', ')}. Install Chrome, or run \`npx playwright install chromium\`.`);
	process.exit(1);
}
const missing = [];
for (let n = 2; n <= count; n++) {
	const png = path.join(out, `slide-${String(n).padStart(2, '0')}.png`);
	way.shot(n, png);
	if (!(await written(png))) missing.push(n);
}
await rm(path.join(out, '.chrome'), { recursive: true, force: true });
await rm(page, { force: true });

console.log(`${count - missing.length} of ${count} slides → ${path.relative(process.cwd(), out) || out}/ (${way.name}${steps === 'none' ? ', before the first Next' : ', every step shown'})`);
if (missing.length) console.log(`  no picture for slide(s) ${missing.join(', ')} — run again, or look at them in the preview`);
console.log('  Look at each picture: text running off the edge, text too small, empty areas, pictures badly cropped. Not for upload.');
process.exit(missing.length ? 1 : 0);
