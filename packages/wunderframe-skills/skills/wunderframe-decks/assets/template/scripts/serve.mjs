#!/usr/bin/env node
/**
 * Rehearse the BUILT deck the way a Wunderframe screen plays it.
 *
 *   npm run preview        → http://localhost:4178  (opens the preview in built mode)
 *
 * Serves the preview harness, dist/<name>.html as /deck.html and public/media/ (with
 * range requests, so videos seek like on a screen). Nothing else: the harness seals
 * the deck with a policy that blocks the network, and lists whatever it tried to load.
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = (pkg.name || 'deck').replace(/^@[^/]+\//, '');
const port = Number(process.env.PORT) || 4178;

let deck = path.join(root, 'dist', `${name}.html`);
if (!existsSync(deck)) {
	const any = existsSync(path.join(root, 'dist')) && readdirSync(path.join(root, 'dist')).find((f) => f.endsWith('.html'));
	if (!any) {
		console.error('No built deck — run `npm run build` first.');
		process.exit(1);
	}
	deck = path.join(root, 'dist', any);
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

function send(res, file, req) {
	if (!file || !existsSync(file) || !statSync(file).isFile()) {
		res.writeHead(404).end('not found');
		return;
	}
	const size = statSync(file).size;
	const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
	const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
	if (range) {
		const start = range[1] ? Number(range[1]) : 0;
		const end = range[2] ? Number(range[2]) : size - 1;
		res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
		createReadStream(file, { start, end }).pipe(res);
	} else {
		res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
		createReadStream(file).pipe(res);
	}
}

const inside = (base, rel) => {
	const p = path.join(base, rel);
	return p.startsWith(base + path.sep) ? p : null;
};

http
	.createServer((req, res) => {
		const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		if (url === '/') return res.writeHead(302, { location: '/preview/?built' }).end();
		if (url === '/deck.html') return send(res, deck, req);
		if (url === '/src/wf-runtime.js') return send(res, path.join(root, 'src', 'wf-runtime.js'), req);
		if (url === '/preview/' || url === '/preview') return send(res, path.join(root, 'preview', 'index.html'), req);
		if (url.startsWith('/preview/')) return send(res, inside(path.join(root, 'preview'), url.slice(9)), req);
		if (url.startsWith('/media/')) return send(res, inside(path.join(root, 'public', 'media'), url.slice(7)), req);
		res.writeHead(404).end('not found');
	})
	.listen(port, () => {
		const at = `http://localhost:${port}/preview/?built`;
		console.log(`Rehearse ${path.relative(root, deck)} as a screen plays it: ${at}`);
		if (!process.env.NO_OPEN) exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} "${at}"`);
	});
