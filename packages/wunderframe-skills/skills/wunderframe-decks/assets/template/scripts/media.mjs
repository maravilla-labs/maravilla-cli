#!/usr/bin/env node
/**
 * Make the deck's pictures and videos fit for a Wunderframe screen — runs before every build.
 *
 *   npm run media            (npm run build runs it first)
 *   node scripts/media.mjs [--small] [--dry]
 *
 * Pictures (src/assets/**):
 *   HEIC/HEIF (iPhone), AVIF, TIFF, BMP → JPEG. No screen shows HEIC; Safari-14-class screens
 *   cannot decode AVIF. Photos longer than 2560 px are shrunk (2560 is plenty on a 1920 canvas).
 * Videos (public/media/*):
 *   anything that is not already a small, streamable MP4 is re-encoded with ffmpeg:
 *   H.264 (yuv420p) + AAC, at most 1920×1080, ≈ 6 Mbit/s cap, "faststart" (the index first,
 *   so a screen can start playing while it still loads). One that is fine but not faststart is
 *   only rewrapped (no quality lost). --small: 1280×720 and ≈ 3 Mbit/s, for a tight zip budget.
 *
 * Posters: every video gets a still (src/assets/<video>-poster.jpg, a frame ~1 s in) unless it
 * has one, and a <video> in index.html without a poster="…" gets that one — it is what the slide
 * shows before Next and in the remote's slide picture. Replace the file to choose another frame.
 *
 * Originals are MOVED to originals/ (same sub-folders; never built, never uploaded), and the
 * new file names are written into index.html and src/ wherever the old ones were used.
 *
 * It uses what the machine has — no npm packages: sips (macOS), ImageMagick (magick/convert),
 * heif-convert (libheif), ffmpeg/ffprobe. When a file MUST be converted and no tool can,
 * it stops with the command to install one (exit 1). --dry: say what would change, change nothing.
 */
import { readdir, readFile, writeFile, mkdir, rename, stat, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const SMALL = args.has('--small');
const MAX_PX = 2560;
const V = SMALL ? { w: 1280, h: 720, crf: 26, max: '3M', buf: '6M' } : { w: 1920, h: 1080, crf: 23, max: '6M', buf: '12M' };
const OK_BITRATE = SMALL ? 3.5e6 : 8e6;

const PIC_CONVERT = new Set(['.heic', '.heif', '.avif', '.tif', '.tiff', '.bmp']);
const PIC_SIZED = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.mpg', '.mpeg', '.3gp', '.mts', '.m2ts']);

const has = (cmd) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).error === undefined;
const run = (cmd, argv) => {
	const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 && !r.error ? r.stdout : null;
};
const tools = {
	sips: process.platform === 'darwin' && existsSync('/usr/bin/sips'),
	magick: has('magick'),
	convert: !has('magick') && process.platform !== 'win32' && run('convert', ['-version'])?.includes('ImageMagick'),
	heif: spawnSync('heif-convert', ['--help'], { stdio: 'ignore' }).error === undefined,
	ffmpeg: has('ffmpeg'),
	ffprobe: has('ffprobe')
};
const INSTALL = {
	darwin: 'brew install ffmpeg imagemagick',
	linux: 'sudo apt-get install -y ffmpeg imagemagick libheif-examples   (or your distribution’s packages)',
	win32: 'winget install Gyan.FFmpeg ImageMagick.ImageMagick'
}[process.platform] ?? 'install ffmpeg and ImageMagick';

const done = [];
const problems = [];
const warnings = []; // worth knowing, not blocking
const renames = []; // [oldRel, newRel] relative to root, for the references

async function walk(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		if (e.name.startsWith('.')) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walk(p)));
		else out.push(p);
	}
	return out;
}
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const free = (p) => {
	if (!existsSync(p)) return p;
	const { dir, name, ext } = path.parse(p);
	for (let i = 1; ; i++) if (!existsSync(path.join(dir, `${name}-${i}${ext}`))) return path.join(dir, `${name}-${i}${ext}`);
};
async function keepOriginal(file) {
	const to = free(path.join(root, 'originals', path.relative(root, file)));
	await mkdir(path.dirname(to), { recursive: true });
	await rename(file, to);
	return to;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ── pictures ─────────────────────────────────────────────────────────────────

function pictureSize(file) {
	if (tools.sips) {
		const o = run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
		const w = /pixelWidth:\s*(\d+)/.exec(o ?? '')?.[1];
		const h = /pixelHeight:\s*(\d+)/.exec(o ?? '')?.[1];
		if (w && h) return [Number(w), Number(h)];
	}
	const im = tools.magick ? ['magick', ['identify', '-format', '%w %h', `${file}[0]`]] : tools.convert ? ['identify', ['-format', '%w %h', `${file}[0]`]] : null;
	if (im) {
		const o = run(im[0], im[1]);
		const m = /^(\d+) (\d+)/.exec(o ?? '');
		if (m) return [Number(m[1]), Number(m[2])];
	}
	if (tools.ffprobe) {
		const o = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
		const m = /^(\d+),(\d+)/.exec(o ?? '');
		if (m) return [Number(m[1]), Number(m[2])];
	}
	return null;
}

/** Write `out` as a JPEG (or the same type, when `sameType`) no longer than MAX_PX; true when it worked. */
function writePicture(src, out, sameType) {
	const ext = path.extname(out).toLowerCase();
	const fmt = sameType ? (ext === '.png' ? 'png' : ext === '.webp' ? null : 'jpeg') : 'jpeg';
	if (tools.sips && fmt) {
		if (run('sips', ['-s', 'format', fmt, ...(fmt === 'jpeg' ? ['-s', 'formatOptions', '82'] : []), '-Z', String(MAX_PX), src, '--out', out]) !== null) return true;
	}
	const im = tools.magick ? ['magick', []] : tools.convert ? ['convert', []] : null;
	if (im && run(im[0], [`${src}[0]`, '-auto-orient', '-resize', `${MAX_PX}x${MAX_PX}>`, '-quality', '82', out]) !== null) return true;
	if (tools.heif && /\.hei[cf]$/i.test(src) && !sameType) {
		if (run('heif-convert', ['-q', '82', src, out]) !== null) {
			const size = pictureSize(out);
			if (!size || Math.max(...size) <= MAX_PX || !tools.ffmpeg) return true;
			const tmp = out + '.tmp.jpg';
			if (run('ffmpeg', ['-y', '-v', 'error', '-i', out, '-vf', `scale='min(${MAX_PX},iw)':'min(${MAX_PX},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', tmp]) !== null) {
				spawnSync('mv', [tmp, out]);
			}
			return true;
		}
	}
	if (tools.ffmpeg && run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', `scale='min(${MAX_PX},iw)':'min(${MAX_PX},ih)':force_original_aspect_ratio=decrease`, ...(path.extname(out) === '.png' ? [] : ['-q:v', '3']), out]) !== null && existsSync(out)) return true;
	return false;
}

for (const file of await walk(path.join(root, 'src', 'assets'))) {
	const ext = path.extname(file).toLowerCase();
	if (PIC_CONVERT.has(ext)) {
		const out = free(file.slice(0, -ext.length) + '.jpg');
		if (DRY) {
			done.push(`would convert ${rel(file)} → ${rel(out)}`);
			continue;
		}
		const orig = await keepOriginal(file);
		if (writePicture(orig, out, false)) {
			done.push(`${rel(file)} → ${rel(out)} (original in ${rel(orig)})`);
			renames.push([rel(file), rel(out)]);
		} else {
			await rename(orig, file);
			problems.push(`${rel(file)}: no screen can show ${ext.slice(1).toUpperCase()}, and nothing here can convert it. Install a converter (${INSTALL}) or export it as JPEG yourself.`);
		}
	} else if (PIC_SIZED.has(ext)) {
		const size = pictureSize(file);
		if (!size || Math.max(...size) <= MAX_PX) continue;
		if (DRY) {
			done.push(`would shrink ${rel(file)} (${size.join('×')}) to ${MAX_PX} px`);
			continue;
		}
		const orig = await keepOriginal(file);
		if (writePicture(orig, file, true)) done.push(`${rel(file)}: ${size.join('×')} → ≤ ${MAX_PX} px (original in ${rel(orig)})`);
		else {
			await rename(orig, file);
			warnings.push(`${rel(file)} is ${size.join('×')} px — fine to keep, but it makes the deck heavier; nothing here could shrink it.`);
		}
	}
}

// ── videos ───────────────────────────────────────────────────────────────────

/** Does this MP4/MOV put its index (moov) after the media (mdat)? Reads only box headers. */
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

function probe(file) {
	const o = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt:format=bit_rate', '-of', 'json', file]);
	if (!o) return null;
	try {
		const j = JSON.parse(o);
		const v = j.streams?.find((s) => s.codec_type === 'video');
		const a = j.streams?.find((s) => s.codec_type === 'audio');
		return { v, a, bitrate: Number(j.format?.bit_rate) || 0 };
	} catch {
		return null;
	}
}

const mediaDir = path.join(root, 'public', 'media');
for (const file of existsSync(mediaDir) ? await readdir(mediaDir) : []) {
	const full = path.join(mediaDir, file);
	const ext = path.extname(file).toLowerCase();
	if (!VIDEO.has(ext) || !(await stat(full)).isFile()) continue;
	const isMp4 = ext === '.mp4' || ext === '.m4v';
	const info = tools.ffprobe ? probe(full) : null;
	const fits =
		isMp4 &&
		info?.v?.codec_name === 'h264' &&
		(info.v.pix_fmt ?? 'yuv420p') === 'yuv420p' &&
		(info.v.width ?? 0) <= V.w &&
		(info.v.height ?? 0) <= V.h &&
		(!info.a || info.a.codec_name === 'aac') &&
		info.bitrate <= OK_BITRATE;
	const slowStart = isMp4 && (await moovAfterMdat(full));
	if (fits && !slowStart) continue;
	if (isMp4 && !info && !slowStart) {
		warnings.push(`${rel(full)}: could not check it (no ffprobe). If it came from a phone or an editor, re-encode it: ${INSTALL}, then npm run media.`);
		continue;
	}
	if (!tools.ffmpeg) {
		// An MP4 that is too big or starts slowly still plays: worth fixing. Any other format: must be converted.
		(isMp4 ? warnings : problems).push(
			`${rel(full)} ${isMp4 ? 'should be made smaller / streamable' : 'must be converted to MP4 (H.264 + AAC)'} and there is no ffmpeg here. Install it (${INSTALL}) and run npm run media again.`
		);
		continue;
	}
	const out = isMp4 ? full : free(full.slice(0, -ext.length) + '.mp4');
	const before = (await stat(full)).size;
	if (DRY) {
		done.push(`would ${fits ? 'rewrap (faststart)' : 're-encode'} ${rel(full)}${isMp4 ? '' : ` → ${rel(out)}`}`);
		continue;
	}
	const orig = await keepOriginal(full);
	const argv = fits
		? ['-y', '-v', 'error', '-i', orig, '-c', 'copy', '-movflags', '+faststart', out]
		: [
				'-y', '-v', 'error', '-i', orig,
				'-map', '0:v:0', '-map', '0:a:0?',
				'-vf', `scale='min(${V.w},iw)':'min(${V.h},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
				'-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', String(V.crf), '-preset', 'medium',
				'-maxrate', V.max, '-bufsize', V.buf,
				'-c:a', 'aac', '-b:a', '128k', '-ac', '2',
				'-movflags', '+faststart', out
			];
	if (run('ffmpeg', argv) !== null && existsSync(out)) {
		const after = (await stat(out)).size;
		done.push(`${rel(full)}${out !== full ? ` → ${rel(out)}` : ''}: ${fits ? 'made streamable' : 're-encoded'}, ${mb(before)} → ${mb(after)} (original in ${rel(orig)})`);
		if (out !== full) renames.push([rel(full), rel(out)]);
	} else {
		await rename(orig, full);
		problems.push(`${rel(full)}: ffmpeg could not convert it — is it a video file? Try: ffmpeg -i "${file}" -c:v libx264 -crf 23 -c:a aac -movflags +faststart out.mp4`);
	}
}

// ── posters: a still for every video, and on every <video> that has none ────

const posters = []; // [video file name, poster rel path from root]
for (const file of existsSync(mediaDir) ? await readdir(mediaDir) : []) {
	if (!/\.(mp4|m4v)$/i.test(file)) continue;
	const poster = path.join(root, 'src', 'assets', `${path.parse(file).name}-poster.jpg`);
	posters.push([file, rel(poster)]);
	if (existsSync(poster) || !tools.ffmpeg || DRY) continue;
	await mkdir(path.dirname(poster), { recursive: true });
	for (const at of ['1', '0']) {
		run('ffmpeg', ['-y', '-v', 'error', '-ss', at, '-i', path.join(mediaDir, file), '-frames:v', '1', '-vf', "scale='min(1920,iw)':-2", '-q:v', '3', poster]);
		if (existsSync(poster) && (await stat(poster)).size > 0) break;
	}
	if (existsSync(poster)) done.push(`poster for media/${file}: ${rel(poster)} (replace it to pick another frame)`);
}

// ── the new names, wherever the old ones were written ───────────────────────

if (renames.length && !DRY) {
	const sources = [path.join(root, 'index.html'), ...(await walk(path.join(root, 'src'))).filter((f) => /\.(html|css|js|mjs|svg)$/i.test(f))];
	for (const f of sources) {
		if (!existsSync(f)) continue;
		let text = await readFile(f, 'utf8');
		const was = text;
		for (const [from, to] of renames) {
			// "src/assets/a.heic" is written "./src/assets/a.heic" or relative to a CSS file ("./assets/a.heic");
			// "public/media/x.mov" is written "/media/x.mov". Replace the file name where its folder path ends it.
			const fromName = path.posix.basename(from);
			const toName = path.posix.basename(to);
			const dir = path.posix.dirname(from).replace(/^public\//, '');
			const tail = dir.split('/').pop();
			const re = new RegExp(`(${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/)${fromName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["'\\s)?#])`, 'g');
			text = text.replace(re, `$1${toName}`);
		}
		if (text !== was) {
			await writeFile(f, text);
			done.push(`updated the file names in ${rel(f)}`);
		}
	}
}

// A <video> naming media/<file> without a poster gets the one made above.
const indexFile = path.join(root, 'index.html');
if (!DRY && posters.length && existsSync(indexFile)) {
	let text = await readFile(indexFile, 'utf8');
	const was = text;
	text = text.replace(/<video\b[^>]*>/gi, (tag) => {
		if (/\sposter\s*=/i.test(tag)) return tag;
		const hit = posters.find(([f, p]) => existsSync(path.join(root, p)) && new RegExp(`media/${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\\s?#]`).test(tag));
		return hit ? tag.replace(/<video\b/i, `<video poster="./${hit[1]}"`) : tag;
	});
	if (text !== was) {
		await writeFile(indexFile, text);
		done.push('added the posters to the <video> tags without one in index.html');
	}
}

// ── report ───────────────────────────────────────────────────────────────────

if (done.length || problems.length || warnings.length) console.log('\nPreparing pictures and videos');
done.forEach((d) => console.log(`  ✓ ${d}`));
warnings.forEach((w) => console.log(`  ! ${w}`));
problems.forEach((p) => console.log(`  ✗ ${p}`));
if (!done.length && !problems.length && !warnings.length) console.log('Pictures and videos: nothing to convert.');
process.exit(problems.length ? 1 : 0);
