/**
 * Web videos (YouTube, Vimeo) drawn ABOVE the deck, as a Wunderframe screen does it.
 *
 * Inside the sealed deck such a player is refused (it inherits the sandbox: no origin, no
 * referrer). The helper (wf-runtime.js) blanks it and posts `{ wf:'deck', embeds:[{ id, src,
 * x, y, w, h, playing }] }` — fractions of the deck frame — and the screen draws the real player
 * there. This is the same logic as the player's DeckEmbeds component, in plain JS.
 */

/** The player address, rebuilt from the video id on an allow-list (never the deck's own string). */
export function embedPlayer(src, origin) {
	let u;
	try {
		u = new URL(src);
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
	if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
		let id = null;
		if (host === 'youtu.be') id = u.pathname.slice(1);
		else if (/^\/(embed|shorts|live|v)\//.test(u.pathname)) id = u.pathname.split('/')[2];
		else if (u.pathname === '/watch') id = u.searchParams.get('v');
		if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
		const q = new URLSearchParams({ enablejsapi: '1', playsinline: '1', rel: '0' });
		const start = parseInt(u.searchParams.get('start') ?? u.searchParams.get('t') ?? '', 10);
		if (start > 0) q.set('start', String(start));
		if (u.searchParams.get('loop') === '1') (q.set('loop', '1'), q.set('playlist', id));
		if (origin) q.set('origin', origin);
		return { provider: 'youtube', url: `https://www.youtube-nocookie.com/embed/${id}?${q}` };
	}
	if (host === 'vimeo.com' || host === 'player.vimeo.com') {
		const parts = u.pathname.split('/').filter(Boolean);
		const at = parts[0] === 'video' ? 1 : 0;
		const id = parts[at];
		if (!id || !/^\d{1,12}$/.test(id)) return null;
		const q = new URLSearchParams({ api: '1', playsinline: '1', dnt: '1' });
		const hash = u.searchParams.get('h') ?? parts[at + 1];
		if (hash && /^[0-9a-f]{6,20}$/.test(hash)) q.set('h', hash);
		return { provider: 'vimeo', url: `https://player.vimeo.com/video/${id}?${q}` };
	}
	return null;
}

const players = new Map(); // key → { el, provider, playing, sound, loaded, played, timers }

function command(p) {
	const send = (m) => p.el.contentWindow?.postMessage(p.provider === 'youtube' ? JSON.stringify(m) : m, '*');
	if (!p.loaded) return;
	if (p.provider === 'youtube') {
		send({ event: 'listening', id: 1, channel: 'widget' });
		if (p.playing) {
			p.played = true;
			send({ event: 'command', func: p.sound ? 'unMute' : 'mute', args: [] });
			send({ event: 'command', func: 'playVideo', args: [] });
		} else if (p.played) send({ event: 'command', func: 'stopVideo', args: [] });
	} else {
		send({ method: 'setVolume', value: p.sound ? 1 : 0 });
		if (p.playing) (p.played = true), send({ method: 'play' });
		else if (p.played) (send({ method: 'pause' }), send({ method: 'setCurrentTime', value: 0 }));
	}
}
function drive(p) {
	p.timers.forEach(clearTimeout);
	command(p);
	p.timers = [setTimeout(() => command(p), 500), setTimeout(() => command(p), 1500)];
}

/** Draw / move / start / stop the players a deck reported. `box` is the deck frame's box. */
export function drawEmbeds(box, list, sound) {
	const seen = new Set();
	for (const e of list || []) {
		const player = embedPlayer(e.src, /^https?:/.test(location.origin) ? location.origin : null);
		if (!player) continue;
		const key = `${e.id}|${player.url}`;
		seen.add(key);
		let p = players.get(key);
		if (!p) {
			const el = document.createElement('iframe');
			el.className = 'wf-embed';
			el.src = player.url;
			el.title = 'Video';
			el.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
			el.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
			el.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
			p = { el, provider: player.provider, playing: false, sound, loaded: false, played: false, timers: [] };
			el.addEventListener('load', () => ((p.loaded = true), drive(p)));
			players.set(key, p);
			box.appendChild(el);
		}
		Object.assign(p.el.style, {
			position: 'absolute',
			inset: 'auto',
			left: `${e.x * 100}%`,
			top: `${e.y * 100}%`,
			width: `${e.w * 100}%`,
			height: `${e.h * 100}%`,
			border: '0',
			background: '#000',
			zIndex: '1'
		});
		if (p.playing !== !!e.playing || p.sound !== sound) {
			p.playing = !!e.playing;
			p.sound = sound;
			drive(p);
		}
	}
	for (const [key, p] of players)
		if (!seen.has(key)) {
			p.timers.forEach(clearTimeout);
			p.el.remove();
			players.delete(key);
		}
}

/** The remote's sound button changed: say it to the players that are drawn. */
export function soundEmbeds(sound) {
	for (const p of players.values()) if (p.sound !== sound) ((p.sound = sound), drive(p));
}
