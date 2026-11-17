#!/usr/bin/env python3
"""
Build the deck WITHOUT npm: one self-contained HTML file (or a .zip with videos).

    python3 scripts/single.py                       # → dist/<name>.html (+ dist/<name>.zip with videos)
    python3 scripts/single.py --out <folder the user downloads from>
    python3 scripts/single.py path/to/talk --name my-talk

For places where `npm install` cannot run (claude.ai and the Claude desktop app run skills in a
sandbox that may have no network): Python 3 standard library only. Pillow is used when present,
to shrink big pictures and convert HEIC/AVIF/TIFF (on macOS `sips` converts HEIC when Pillow
cannot); without either, pictures are inlined as they are.

What it does, mirroring `npm run build` (Vite + vite-plugin-singlefile + scripts/build.mjs):
  - <link rel="stylesheet" href="./…">  → <style>, with @import and url() inlined
  - <script type="module" src="./…">    → one inline module; relative `import`s are bundled
                                           (bare npm imports are refused — they need Vite)
  - pictures and fonts (src, poster, srcset, url(…), style="…")  → data: URLs
  - videos referenced as "/media/<file>" (in public/media/) → media/<file> + a zip, with the same
    limits Wunderframe applies (zip ≤ 40 MB, page ≤ 25 MB, a video ≤ 8 MB is folded into the page)
  - HTML comments are dropped (author notes and commented-out slides do not go on stage)
It does NOT transpile: write JavaScript Safari 14 runs (the template's deck.js does).
Then it runs basic checks, and scripts/check.mjs too when `node` is available.
"""
import argparse
import base64
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import zipfile

MB = 1024 * 1024
HTML_MAX = 25 * MB
ZIP_MAX = 40 * MB
INLINE_MAX = 8 * MB

MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.json': 'application/json',
}
SAFE_PICTURES = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.ico'}
CONVERT_PICTURES = {'.heic', '.heif', '.avif', '.tif', '.tiff', '.bmp'}
MEDIA = {'.mp4', '.m4v', '.webm', '.mov', '.mp3', '.m4a', '.wav'}

problems = []  # (symbol, text)


def say(sym, text):
    problems.append((sym, text))


def is_local(ref):
    r = ref.strip()
    return bool(r) and not re.match(r'^(?:[a-z][a-z0-9+.-]*:|//|#)', r, re.I)


def resolve(ref, base_dir, root):
    """A page reference → a file. "/x" is the project root, then public/ (Vite's rules)."""
    r = re.split(r'[?#]', ref.strip(), 1)[0]
    from urllib.parse import unquote
    r = unquote(r)
    if r.startswith('/'):
        for cand in (os.path.join(root, r[1:]), os.path.join(root, 'public', r[1:])):
            if os.path.isfile(cand):
                return cand
        return None
    cand = os.path.normpath(os.path.join(base_dir, r))
    return cand if os.path.isfile(cand) else None


# ── pictures ────────────────────────────────────────────────────────────────
def sips_jpeg(path, max_px):
    """macOS fallback for HEIC & co. when Pillow can't read them: `sips` ships with the system."""
    if not shutil.which('sips'):
        return None
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, 'out.jpg')
        r = subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', str(max_px), path, '--out', out],
                           capture_output=True)
        if r.returncode == 0 and os.path.isfile(out):
            say('·', f'{os.path.basename(path)}: converted to JPEG with sips')
            return open(out, 'rb').read()
    return None


def picture_bytes(path, max_px, resize):
    ext = os.path.splitext(path)[1].lower()
    data = open(path, 'rb').read()
    if ext == '.svg' or ext == '.gif' or ext == '.ico':
        return data, MIME[ext]
    try:
        from PIL import Image  # optional
        try:
            import pillow_heif  # optional: HEIC/HEIF support
            pillow_heif.register_heif_opener()
        except Exception:
            pass
    except Exception:
        Image = None
    if ext in CONVERT_PICTURES:
        if Image is None:
            jpg = sips_jpeg(path, max_px)
            if jpg:
                return jpg, 'image/jpeg'
            raise SystemExit(f'✗ {path}: {ext[1:].upper()} cannot be shown by screens and Pillow is not available to convert it — '
                             'export it as JPEG first (macOS: sips -s format jpeg in.heic --out out.jpg).')
    elif ext not in SAFE_PICTURES:
        return data, MIME.get(ext) or mimetypes.guess_type(path)[0] or 'application/octet-stream'
    if Image is None:
        if len(data) > 1.5 * MB:
            say('!', f'{os.path.basename(path)} is {len(data) / MB:.1f} MB and Pillow is not available to shrink it — 2560 px wide, JPEG q≈80 is plenty.')
        return data, MIME[ext]
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception as e:
        if ext in CONVERT_PICTURES:
            jpg = sips_jpeg(path, max_px)
            if jpg:
                return jpg, 'image/jpeg'
            raise SystemExit(f'✗ {path}: cannot read it ({e}) — export it as JPEG first.')
        return data, MIME[ext]
    try:
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)  # phone photos: apply the rotation the camera recorded
    except Exception:
        pass
    big = max(im.size) > max_px
    if not (ext in CONVERT_PICTURES or (resize and (big or len(data) > 1.5 * MB))):
        return data, MIME[ext]
    if resize and big:
        im.thumbnail((max_px, max_px))
    alpha = im.mode in ('RGBA', 'LA', 'P') and (im.mode != 'P' or 'transparency' in im.info)
    out = io.BytesIO()
    if alpha:
        im.save(out, 'PNG', optimize=True)
        mime = 'image/png'
    else:
        im.convert('RGB').save(out, 'JPEG', quality=82, optimize=True, progressive=True)
        mime = 'image/jpeg'
    new = out.getvalue()
    if ext in SAFE_PICTURES and len(new) >= len(data) and not big:
        return data, MIME[ext]
    say('·', f'{os.path.basename(path)}: {len(data) // 1024} KB → {len(new) // 1024} KB ({im.size[0]}×{im.size[1]})')
    return new, mime


class Inliner:
    def __init__(self, root, max_px, resize):
        self.root = root
        self.max_px = max_px
        self.resize = resize
        self.cache = {}
        self.media = {}  # ref in page ("media/x.mp4") → file

    def data_url(self, path):
        if path not in self.cache:
            ext = os.path.splitext(path)[1].lower()
            if ext in SAFE_PICTURES or ext in CONVERT_PICTURES:
                data, mime = picture_bytes(path, self.max_px, self.resize)
            else:
                data = open(path, 'rb').read()
                mime = MIME.get(ext) or mimetypes.guess_type(path)[0] or 'application/octet-stream'
            self.cache[path] = f'data:{mime};base64,{base64.b64encode(data).decode()}'
        return self.cache[path]

    def ref(self, ref, base_dir, where):
        """A local reference → a data: URL, or media/<file> for videos and sound."""
        if not is_local(ref) or ref.startswith('data:'):
            return ref
        clean = re.split(r'[?#]', ref.strip(), 1)[0]
        ext = os.path.splitext(clean)[1].lower()
        if ext in MEDIA or re.match(r'^\.?/?media/', clean):
            name = re.sub(r'^\.?/?(?:public/)?media/', '', clean.lstrip('./')) if 'media/' in clean else os.path.basename(clean)
            f = resolve(ref, base_dir, self.root) or resolve('/media/' + name, base_dir, self.root)
            self.media['media/' + name] = f
            return 'media/' + name
        f = resolve(ref, base_dir, self.root)
        if not f:
            say('✗', f'{where}: "{ref}" not found — it would be missing on the screen.')
            return ref
        return self.data_url(f)

    # ── CSS ──
    def css(self, text, base_dir, seen=None):
        seen = seen or set()
        text = re.sub(r'/\*[\s\S]*?\*/', '', text)  # comments (they may show markup the checks would count)

        def imp(m):
            target = m.group(1) or m.group(2)
            if not is_local(target):
                return m.group(0)
            f = resolve(target, base_dir, self.root)
            if not f or f in seen:
                return '' if f in seen else m.group(0)
            seen.add(f)
            return self.css(open(f, encoding='utf-8').read(), os.path.dirname(f), seen)

        text = re.sub(r'@import\s+(?:url\(\s*["\']?([^"\')]+)["\']?\s*\)|["\']([^"\']+)["\'])[^;]*;', imp, text)
        return re.sub(r'url\(\s*(["\']?)([^"\')]+)\1\s*\)',
                      lambda m: f'url("{self.ref(m.group(2), base_dir, "css")}")', text)

    # ── JS: a tiny bundler for relative ES imports ──
    def js(self, entry):
        """The entry module's code with every relative import resolved: each imported module becomes
        `const __wf_modN = (function () { …; return { exports }; })();` ahead of the entry."""
        mods, order, css = {}, [], []
        IMPORT = re.compile(r'^[ \t]*import\s+(?:([\s\S]*?)\s+from\s+)?["\']([^"\']+)["\'][ \t]*;?', re.M)

        def bind(spec, var):
            spec, out = spec.strip(), []
            m = re.match(r'^([A-Za-z_$][\w$]*)\s*(?:,\s*([\s\S]*))?$', spec)
            if m:  # default import, maybe followed by { … } or * as ns
                out.append(f'const {m.group(1)} = {var}.default;')
                spec = (m.group(2) or '').strip()
            ns = re.match(r'^\*\s*as\s+([\w$]+)$', spec)
            if ns:
                out.append(f'const {ns.group(1)} = {var};')
            elif spec.startswith('{'):
                parts = []
                for n in spec.strip('{} \n\t').split(','):
                    n = n.strip()
                    if n:
                        a, _, b = n.partition(' as ')
                        parts.append(f'{a.strip()}: {b.strip()}' if b else a)
                out.append('const { ' + ', '.join(parts) + ' } = ' + var + ';')
            return '\n'.join(out)

        def load(path, chain):
            if path in mods:
                return mods[path]
            if path in chain:
                raise SystemExit('✗ circular import: ' + ' → '.join(chain + [path]))
            src = open(path, encoding='utf-8').read()
            base, rel = os.path.dirname(path), os.path.relpath(path, self.root)

            def sub(m):
                spec, target = m.group(1), m.group(2)
                if not target.startswith(('.', '/')):
                    raise SystemExit(f'✗ {rel} imports the npm package "{target}". The no-build path cannot resolve '
                                     'packages: use `npm run build`, or copy the file into src/ and import it relatively.')
                f = resolve(target, base, self.root)
                if not f:
                    raise SystemExit(f'✗ {rel}: import "{target}" not found.')
                if f.endswith('.css'):
                    css.append(self.css(open(f, encoding='utf-8').read(), os.path.dirname(f)))
                    return ''
                if not f.endswith(('.js', '.mjs')):
                    raise SystemExit(f'✗ {rel}: importing "{target}" needs Vite — reference the file from HTML/CSS instead.')
                var = load(f, chain + [path])
                return bind(spec, var) if spec else ''

            # Whole-line comments go (Vite's minifier drops them too): doc comments that show markup
            # would otherwise read as part of the deck to the checks. Comments after code stay.
            src = re.sub(r'^[ \t]*/\*[\s\S]*?\*/[ \t]*\n?', '', src, flags=re.M)
            src = re.sub(r'^[ \t]*//.*\n?', '', src, flags=re.M)
            code = IMPORT.sub(sub, src)
            if path == entry:
                return code
            names = [(n, n) for n in re.findall(r'^[ \t]*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)', code, re.M)]
            code = re.sub(r'^([ \t]*)export\s+(?=(?:async\s+)?(?:function\*?|class|const|let|var)\s)', r'\1', code, flags=re.M)

            def exp_list(m):
                for part in m.group(1).split(','):
                    local, _, public = part.strip().partition(' as ')
                    if local:
                        names.append(((public or local).strip(), local.strip()))
                return ''

            code = re.sub(r'^[ \t]*export\s*\{([^}]*)\}\s*;?', exp_list, code, flags=re.M)
            if re.search(r'^[ \t]*export\s+default\s', code, re.M):
                code = re.sub(r'^([ \t]*)export\s+default\s', r'\1const __default = ', code, count=1, flags=re.M)
                names.append(('default', '__default'))
            var = f'__wf_mod{len(order) + 1}'
            body = ', '.join(f'{pub}: {loc}' if pub != loc else pub for pub, loc in names)
            order.append(f'const {var} = (function () {{\n{code}\nreturn {{ {body} }};\n}})();')
            mods[path] = var
            return var

        main = load(entry, [])
        return '\n'.join(order + [main]), css


TAG = re.compile(r'<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>"\']+))?)*)\s*(/?)>')
LOADS = re.compile(r'(\s)(src|poster|srcset|href|xlink:href|style)(\s*=\s*)(["\'])(.*?)\4', re.S)


def build_html(root, entry, inl):
    html = open(entry, encoding='utf-8').read()
    base = os.path.dirname(entry)
    html = re.sub(r'<!--[\s\S]*?-->', '', html)

    # 1. Attributes that load something: src, poster, srcset, <image>/<use> href, url() in style="…".
    def attrs(m):
        tag = m.group(1).lower()
        if tag in ('a', 'script', 'link', 'iframe', 'base'):
            return m.group(0)

        def one(a):
            name, q, val = a.group(2).lower(), a.group(4), a.group(5)
            if name == 'style':
                if 'url(' not in val:
                    return a.group(0)
                new = inl.css(val, base).replace('"', "'") if q == '"' else inl.css(val, base)
            elif name in ('href', 'xlink:href'):
                if tag not in ('image', 'use') or not is_local(val):
                    return a.group(0)
                new = inl.ref(val, base, f'<{tag} {name}>')
            elif name == 'srcset':
                new = ', '.join(' '.join([inl.ref(b[0], base, f'<{tag} srcset>')] + b[1:])
                                for b in (i.strip().split() for i in val.split(',')) if b)
            else:
                if not is_local(val):
                    return a.group(0)
                new = inl.ref(val, base, f'<{tag} {name}>')
            return f'{a.group(1)}{a.group(2)}{a.group(3)}{q}{new}{q}'

        return f'<{m.group(1)}{LOADS.sub(one, m.group(2))}{m.group(3)}>'

    # Only outside <script>/<style> bodies (text inside them is code, not markup).
    parts = re.split(r'(<(script|style)\b[\s\S]*?</\2>)', html, flags=re.I)
    out = []
    i = 0
    while i < len(parts):
        out.append(TAG.sub(attrs, parts[i]))
        if i + 1 < len(parts):
            out.append(parts[i + 1])
        i += 3
    html = ''.join(out)

    # 2. <style> blocks of the page.
    html = re.sub(r'(<style\b[^>]*>)([\s\S]*?)(</style>)', lambda m: m.group(1) + inl.css(m.group(2), base) + m.group(3), html, flags=re.I)

    # 3. Stylesheets.
    def link(m):
        tag = m.group(0)
        href = re.search(r'href\s*=\s*["\']([^"\']+)', tag)
        if not href or not is_local(href.group(1)):
            return tag  # the checks flag a network stylesheet
        if re.search(r'rel\s*=\s*["\']?[^"\'>]*\bicon\b', tag, re.I):
            return tag.replace(href.group(1), inl.ref(href.group(1), base, 'icon'), 1)
        if not re.search(r'rel\s*=\s*["\']?stylesheet', tag, re.I):
            return tag
        f = resolve(href.group(1), base, root)
        if not f:
            say('✗', f'stylesheet "{href.group(1)}" not found')
            return ''
        return '<style>\n' + inl.css(open(f, encoding='utf-8').read(), os.path.dirname(f)) + '\n</style>'

    html = re.sub(r'<link\b[^>]*>', link, html, flags=re.I)

    # 4. Scripts (a module is bundled with its relative imports; CSS it imports goes into <head>).
    head_css = []

    def script(m):
        attrs_ = m.group(1)
        src = re.search(r'\ssrc\s*=\s*["\']([^"\']+)', attrs_)
        if not src or not is_local(src.group(1)):
            return m.group(0)
        f = resolve(src.group(1), base, root)
        if not f:
            say('✗', f'script "{src.group(1)}" not found')
            return ''
        if re.search(r'type\s*=\s*["\']?module', attrs_):
            code, css = inl.js(f)
            head_css.extend(css)
            kind = ' type="module"'
        else:
            code, kind = open(f, encoding='utf-8').read(), ''
        # "</script" inside the code would end the element early.
        return f'<script{kind}>\n' + code.replace('</script', '<\\/script') + '\n</script>'

    html = re.sub(r'<script\b([^>]*)>\s*</script>', script, html, flags=re.I)
    if head_css:
        style = '<style>\n' + '\n'.join(head_css) + '\n</style>'
        html = re.sub(r'</head>', lambda _: style + '</head>', html, count=1, flags=re.I) if re.search(r'</head>', html, re.I) else style + html
    return html


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description='Build a Wunderframe deck into one HTML file without npm.')
    ap.add_argument('project', nargs='?', default=os.path.dirname(here), help='the deck folder (default: this template)')
    ap.add_argument('--entry', default='index.html')
    ap.add_argument('--out', help='output folder (default: <project>/dist)')
    ap.add_argument('--name', help='file name without extension (default: package.json "name" or the folder name)')
    ap.add_argument('--max-px', type=int, default=2560, help='longest side of an inlined photo (default 2560)')
    ap.add_argument('--no-resize', action='store_true', help='inline pictures exactly as they are')
    a = ap.parse_args()

    root = os.path.abspath(a.project)
    entry = os.path.join(root, a.entry)
    if not os.path.isfile(entry):
        raise SystemExit(f'✗ {entry} not found')
    name = a.name
    if not name:
        try:
            name = json.load(open(os.path.join(root, 'package.json'))).get('name', '')
        except Exception:
            name = ''
        name = re.sub(r'^@[^/]+/', '', name or os.path.basename(root)) or 'deck'
    out = os.path.abspath(a.out or os.path.join(root, 'dist'))
    os.makedirs(out, exist_ok=True)

    inl = Inliner(root, a.max_px, not a.no_resize)
    html = build_html(root, entry, inl)
    html_bytes = len(html.encode('utf-8'))
    html_file = os.path.join(out, f'{name}.html')
    zip_file = os.path.join(out, f'{name}.zip')
    if os.path.exists(zip_file):
        os.remove(zip_file)
    with open(html_file, 'w', encoding='utf-8') as fh:
        fh.write(html)

    fmt = lambda b: f'{b / MB:.1f} MB' if b >= MB else f'{max(1, round(b / 1024))} KB'
    print(f'\n{html_file}  {fmt(html_bytes)}{"  ✗ over 25 MB" if html_bytes > HTML_MAX else ""}')

    if inl.media:
        entries = [('index.html', html.encode('utf-8'), zipfile.ZIP_DEFLATED)]
        zip_bytes, budget = html_bytes, HTML_MAX - html_bytes
        found = sorted(((r, f, os.path.getsize(f)) for r, f in inl.media.items() if f), key=lambda x: x[2])
        for ref, f, size in found:
            folds = size <= INLINE_MAX
            if zip_bytes + size > ZIP_MAX or (folds and size * 1.34 > budget):
                print(f'  ↑ {ref}  {fmt(size)}  NOT in the zip (limits) — after uploading, "Add video" → choose this file')
                continue
            entries.append((ref, open(f, 'rb').read(), zipfile.ZIP_STORED))
            zip_bytes += size
            if folds:
                budget -= size * 1.34
            print(f'  ✓ {ref}  {fmt(size)}  {"folded into the page" if folds else "kept as a library video"}')
        for ref, f in inl.media.items():
            if not f:
                print(f'  ✗ {ref}  missing (put it in public/media/) — the screen shows only its poster until you "Add video"')
        with zipfile.ZipFile(zip_file, 'w') as z:
            for arc, data, how in entries:
                z.writestr(arc, data, compress_type=how)
        print(f'{zip_file}  {fmt(os.path.getsize(zip_file))}  ← upload this one (the deck has media)')
    else:
        print('  no videos → upload the .html file')

    # Basic checks (scripts/check.mjs does the full set when node is available).
    body = re.sub(r'<!--[\s\S]*?-->', '', html)
    if html_bytes > HTML_MAX:
        say('✗', 'The page is over 25 MB — shrink pictures (--max-px 1920) or move videos to public/media/.')
    if not (re.search(r'wf\s*(?:===?|:)\s*["\']deck["\']', body) and 'postMessage' in body):
        say('✗', 'The deck does not speak the Wunderframe deck protocol (wf:"deck"): the remote cannot drive it.')
    for m in re.finditer(r'<(\w+)\b[^>]*?\s(?:src|href|poster)\s*=\s*["\']((?:https?:)?//[^"\']+)', body, re.I):
        if m.group(1).lower() not in ('a', 'iframe'):
            say('✗', f'Loaded from the network, missing on a screen: <{m.group(1)}> {m.group(2)}')
    for m in re.finditer(r'url\(\s*["\']?((?:https?:)?//[^"\')\s]+)', body):
        say('✗', f'Loaded from the network, missing on a screen: url({m.group(1)})')
    for sym, text in problems:
        print(f'  {sym} {text}')

    sys.stdout.flush()
    node = shutil.which('node')
    checker = os.path.join(here, 'check.mjs')
    if node and os.path.isfile(checker):
        r = subprocess.run([node, checker, html_file], cwd=root)
        sys.exit(r.returncode)
    print('  · node is not available: only the basic checks ran.')
    sys.exit(1 if any(s == '✗' for s, _ in problems) else 0)


if __name__ == '__main__':
    main()
