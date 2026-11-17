import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained HTML file: every script, stylesheet, picture and font is
// inlined, because a Wunderframe screen plays the deck in a sealed frame that
// cannot fetch anything. Videos are the exception: keep them in public/media/
// and reference them as "/media/<file>" — scripts/build.mjs puts them in the zip.
export default defineConfig({
	plugins: [viteSingleFile()],
	build: {
		// Venue screens and lectern Macs are often old: Safari 14 is the floor.
		target: 'safari14',
		assetsInlineLimit: 100_000_000,
		cssCodeSplit: false,
		// One file has nothing to preload; the polyfill would only add a fetch() to the page.
		modulePreload: { polyfill: false },
		outDir: 'dist/.vite',
		emptyOutDir: true
	}
});
