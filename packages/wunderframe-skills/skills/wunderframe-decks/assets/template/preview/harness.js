/**
 * A local stand-in for a Wunderframe screen and the presenter's remote.
 *
 *   npm run dev       → live mode: frames the dev server's deck (hot reload while you write)
 *   npm run preview   → built mode (?built): frames dist/<name>.html exactly as a screen does —
 *                       sandbox="allow-scripts" (opaque origin), the step helper injected first,
 *                       and a Content-Security-Policy that blocks every network request, so any
 *                       font / picture / script that would be missing on the stage is listed.
 *
 * It speaks the deck protocol v1 like the remote: next / prev / first / last / goto / hello /
 * audio in, { state }, { build } and { embeds } out. Web videos (YouTube, Vimeo) are drawn above the
 * deck, as a screen does (./embeds.js).
 */
import { DECK_RUNTIME_JS } from '/src/wf-runtime.js';
import { drawEmbeds, soundEmbeds } from './embeds.js';

const built = new URLSearchParams(location.search).has('built');
const $ = (id) => document.getElementById(id);
const box = $('box');
const issues = $('issues');

let frame = null;
let deckHtml = null; // built mode: the page as a screen receives it
let pictureHtml = null; // built mode: the page as Wunderframe photographs it for the remote's slide pictures
let state = null; // last state from the deck
let build = null; // { index, build, builds } sent on its own by the helper
let remembered = 0; // the slide the "phone" remembers, for reloads
let sound = true;
let lastHeard = 0;

$('mode').textContent = built ? 'built file · sealed like a screen' : 'live dev';
$('mode').className = 'chip ' + (built ? 'ok' : '');

function note(text, cls = '') {
	if ([...issues.children].some((d) => d.textContent === text)) return;
	const d = document.createElement('div');
	d.textContent = text;
	d.className = cls;
	issues.appendChild(d);
}

// The slide pictures on the remote are taken WITHOUT the step helper (every step shown) about a
// second after the slide arrives. The built-mode grid mimics that: helper off, and every animation
// frozen 1 s after the slide was asked for — whatever is still on its way is missing, as on the remote.
const PICTURE =
	`<script>window.__wfDeck={sync:function(){}};addEventListener('message',function(e){var m=e.data;` +
	`if(m&&m.wf==='deck'&&m.cmd==='goto')setTimeout(function(){var s=document.createElement('style');` +
	`s.textContent='*,*::before,*::after{animation-play-state:paused!important;transition:none!important}';` +
	`document.head.appendChild(s)},1000)})<\/script>`;

async function pageForScreen(picture = false) {
	const res = await fetch('/deck.html', { cache: 'no-store' });
	if (!res.ok) throw new Error('No built deck — run `npm run build` first.');
	const html = await res.text();
	const csp = [
		"default-src 'none'",
		"script-src 'unsafe-inline'",
		"style-src 'unsafe-inline'",
		'img-src data: blob:',
		'font-src data:',
		`media-src data: blob: ${location.origin}`
	].join('; ');
	const inject =
		`<base href="${location.origin}/">` +
		`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
		`<script>document.addEventListener('securitypolicyviolation',function(e){parent.postMessage({wfPreview:'blocked',uri:e.blockedURI,directive:e.effectiveDirective},'*')})<\/script>` +
		(picture ? PICTURE : `<script>${DECK_RUNTIME_JS}<\/script>`);
	const head = /<head\b[^>]*>/i.exec(html);
	return head ? html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length) : inject + html;
}

function makeFrame(target, picture = false) {
	const f = document.createElement('iframe');
	f.setAttribute('allow', 'autoplay; fullscreen');
	if (built) {
		f.setAttribute('sandbox', 'allow-scripts');
		f.srcdoc = picture && pictureHtml ? pictureHtml : deckHtml;
	} else {
		// Live mode keeps same-origin so Vite's hot reload works; `npm run preview` is the strict check.
		f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
		f.src = '/';
	}
	target.appendChild(f);
	return f;
}

const send = (cmd, extra = {}, to = frame) => to?.contentWindow?.postMessage({ wf: 'deck', v: 1, cmd, ...extra }, '*');

function render() {
	if (!state) return;
	$('num').textContent = `Slide ${state.index + 1} of ${state.count}`;
	$('title').textContent = state.title || '';
	const b = state.builds ? state : build && build.index === state.index ? build : null;
	$('step').textContent = b && b.builds ? `step ${b.build} of ${b.builds}` : '';
	$('notes').textContent = state.notes || '';
	document.querySelectorAll('.thumb').forEach((t, i) => t.classList.toggle('on', i === state.index));
}

window.addEventListener('message', (e) => {
	const m = e.data;
	if (m && m.wfPreview === 'blocked') {
		// A YouTube / Vimeo frame inside the deck is blanked by the helper and drawn by the screen: not missing.
		if (/youtube(-nocookie)?\.com|youtu\.be|vimeo\.com/.test(m.uri || '')) return;
		note(`Blocked on a screen (${m.directive}): ${m.uri || '(inline)'} — inline it or put it in the zip`);
		return;
	}
	if (!m || m.wf !== 'deck') return;
	const thumb = [...document.querySelectorAll('.thumb iframe')].indexOf(
		[...document.querySelectorAll('.thumb iframe')].find((f) => f.contentWindow === e.source)
	);
	if (thumb >= 0) {
		if (m.state?.ready) send('goto', { index: thumb }, document.querySelectorAll('.thumb iframe')[thumb]);
		return;
	}
	if (!frame || e.source !== frame.contentWindow) return;
	lastHeard = Date.now();
	$('conn').textContent = 'deck answers';
	$('conn').className = 'chip ok';
	if (m.state) {
		const s = m.state;
		if (!Number.isInteger(s.index) || !Number.isInteger(s.count) || s.count < 1) {
			note('The deck posted a state without integer index/count.');
			return;
		}
		if (build && build.index !== s.index) build = null;
		state = s;
		if (s.ready) {
			send('audio', { on: sound });
			// A screen that reloaded starts at slide 1: the remote sends it back.
			if (remembered && s.index !== remembered) send('goto', { index: remembered });
		}
		remembered = s.index;
		if (!s.title) note(`Slide ${s.index + 1} has no title for the remote (data-title or a heading).`, 'info');
	}
	if (m.build) build = { index: state ? state.index : -1, ...m.build };
	if (Array.isArray(m.embeds)) drawEmbeds(box, m.embeds, sound);
	render();
});

async function load() {
	drawEmbeds(box, [], sound);
	box.innerHTML = '';
	state = null;
	try {
		if (built) [deckHtml, pictureHtml] = await Promise.all([pageForScreen(), pageForScreen(true)]);
	} catch (err) {
		note(err.message);
		return;
	}
	frame = makeFrame(box);
	frame.addEventListener('load', () => {
		// A deck that never says ready is not driven by the remote.
		setTimeout(() => {
			if (!state) {
				send('hello');
				setTimeout(() => {
					if (!state) {
						$('conn').textContent = 'no answer — does the deck speak the protocol?';
						$('conn').className = 'chip warn';
					}
				}, 1500);
			}
		}, 1500);
	});
}

function openGrid() {
	const grid = $('grid');
	if (grid.classList.toggle('open')) {
		grid.innerHTML = '';
		const n = Math.min(state?.count ?? 0, 60);
		if (built) {
			const h = document.createElement('p');
			h.style.cssText = 'grid-column: 1 / -1; margin: 0; color: var(--muted)';
			h.textContent = 'As the remote shows them: every step in, photographed about 1 s after the slide arrives — anything missing here is still animating at that moment.';
			grid.appendChild(h);
		}
		for (let i = 0; i < n; i++) {
			const t = document.createElement('div');
			t.className = 'thumb';
			const fr = document.createElement('div');
			fr.className = 'frame';
			t.appendChild(fr);
			const label = document.createElement('span');
			label.textContent = `${i + 1}`;
			t.appendChild(label);
			grid.appendChild(t);
			const f = makeFrame(fr, true);
			requestAnimationFrame(() => (f.style.transform = `scale(${fr.clientWidth / 1920})`));
			t.addEventListener('click', () => {
				send('goto', { index: i });
				grid.classList.remove('open');
			});
		}
		render();
	} else grid.innerHTML = '';
}

$('next').onclick = () => send('next');
$('prev').onclick = () => send('prev');
$('first').onclick = () => send('first');
$('last').onclick = () => send('last');
$('gridBtn').onclick = openGrid;
$('reload').onclick = () => load();
$('sound').onclick = (e) => {
	sound = !sound;
	e.currentTarget.setAttribute('aria-pressed', String(sound));
	e.currentTarget.textContent = sound ? 'Sound on' : 'Sound off';
	send('audio', { on: sound });
	soundEmbeds(sound);
};
document.querySelectorAll('button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));

window.addEventListener('keydown', (e) => {
	const k = e.key;
	if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) send('next');
	else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) send('prev');
	else if (k === 'Home') send('first');
	else if (k === 'End') send('last');
	else if (k === 'g' || k === 'G') openGrid();
	else if (k === 'r' || k === 'R') load();
	else if (k === 'Escape') $('grid').classList.remove('open');
	else return;
	e.preventDefault();
});
// Keys pressed while the deck frame has focus go to the deck itself — bring focus back here.
setInterval(() => {
	if (document.activeElement === frame) window.focus();
}, 500);

load();
