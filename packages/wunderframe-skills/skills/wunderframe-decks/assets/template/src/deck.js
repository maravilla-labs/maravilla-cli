/**
 * The deck engine: a fixed 1920×1080 canvas scaled to the window, one <section>
 * per slide, and the Wunderframe deck protocol v1 so a presenter's phone, the
 * lectern, a clicker or hand signs can drive it on the venue's screens.
 *
 * Authoring lives in index.html — you should rarely need to touch this file.
 *
 *   <section data-title="Optional title for the remote">
 *     …slide content…
 *     <aside class="notes">Speaker notes, plain text, shown on the remote/prompter.</aside>
 *   </section>
 *
 *   (or data-notes="…" on the section — one line per paragraph)
 *
 * Steps (data-wf-step) and video-on-Next (data-wf-play) are handled by the
 * Wunderframe helper in ./wf-runtime.js — the same script the screens inject.
 *
 * Styles and fonts are linked from index.html (src/fonts/fonts.css, src/deck.css), and this
 * file imports only ./wf-runtime.js: that keeps it buildable both by Vite (npm run build)
 * and by scripts/single.py where npm is not available. Keep it that way — no npm imports —
 * and write plain JS that Safari 14 runs (no .at(), structuredClone, Object.hasOwn, top-level await).
 */
import { installDeckRuntime } from './wf-runtime.js';

// The helper must listen before the deck does: it takes Next/Back while a slide has steps left.
installDeckRuntime();

const W = 1920;
const H = 1080;
const embedded = window.parent !== window;
const stage = document.querySelector('.stage');
const slides = Array.from(stage.querySelectorAll(':scope > section'));
const progress = stage.querySelector(':scope > .progress');
let current = -1;
let reported = false;

// ── layout ─────────────────────────────────────────────────────────────────
// A frame can run this before it has a size (0×0): scale(0) would hide the deck until a resize
// that may never come. So: wait for a size, and refit on every size change.
function fit() {
	const w = window.innerWidth || document.documentElement.clientWidth;
	const h = window.innerHeight || document.documentElement.clientHeight;
	if (!w || !h) return void requestAnimationFrame(fit);
	stage.style.transform = `translate(-50%, -50%) scale(${Math.min(w / W, h / H)})`;
}
window.addEventListener('resize', fit);
if (window.ResizeObserver) new ResizeObserver(fit).observe(document.documentElement);
fit();

// ── slides ─────────────────────────────────────────────────────────────────
const clean = (t) => t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();

function notesOf(section) {
	const aside = section.querySelector('aside.notes');
	if (!aside) return clean(section.dataset.notes || '').replace(/\n+/g, '\n\n').slice(0, 4000);
	const blocks = aside.querySelectorAll('p, li');
	const text = blocks.length
		? Array.from(blocks, (b) => (b.tagName === 'LI' ? '• ' : '') + clean(b.textContent)).join('\n\n')
		: clean(aside.textContent);
	return text.slice(0, 4000);
}

function titleOf(section, i) {
	if (section.dataset.title) return section.dataset.title;
	const h = section.querySelector('h1, h2, h3');
	return h ? clean(h.textContent).slice(0, 200) : `Slide ${i + 1}`;
}

function show(i) {
	const next = Math.max(0, Math.min(slides.length - 1, i));
	if (next === current) return report();
	slides.forEach((s, n) => {
		s.hidden = n !== next;
		s.classList.toggle('current', n === next);
	});
	// Videos of slides that are gone stop (the helper does this for data-wf-play ones).
	slides.forEach((s, n) => {
		if (n !== next) s.querySelectorAll('video').forEach((v) => v.pause());
	});
	current = next;
	if (progress) progress.style.setProperty('--progress', String((current + 1) / slides.length));
	if (!embedded) {
		try {
			history.replaceState(null, '', `#${current + 1}`);
		} catch {
			/* sandboxed: no history */
		}
	}
	report();
}

// ── Wunderframe deck protocol v1 ───────────────────────────────────────────
function report() {
	if (!embedded) return;
	const s = slides[current];
	window.parent.postMessage(
		{
			wf: 'deck',
			v: 1,
			state: {
				index: current,
				count: slides.length,
				title: titleOf(s, current),
				notes: notesOf(s),
				...(reported ? {} : { ready: true })
			}
		},
		'*'
	);
	reported = true;
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

// Keys and clicks become protocol commands sent to ourselves, so they take
// exactly the path a remote's command takes (steps first, then slides).
const send = (cmd, extra) => window.postMessage({ wf: 'deck', v: 1, cmd, ...extra }, '*');
window.addEventListener('keydown', (e) => {
	if (e.metaKey || e.ctrlKey || e.altKey) return;
	const k = e.key;
	if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) send('next');
	else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) send('prev');
	else if (k === 'Home') send('first');
	else if (k === 'End') send('last');
	else if (k === 'f' && !embedded) document.documentElement.requestFullscreen?.();
	else return;
	e.preventDefault();
});
if (!embedded) {
	window.addEventListener('click', (e) => {
		if (e.target.closest('a, button, video[controls]')) return;
		send(e.clientX > window.innerWidth / 3 ? 'next' : 'prev');
	});
}

const start = embedded ? 0 : Math.max(0, (parseInt(location.hash.slice(1), 10) || 1) - 1);
show(start);
