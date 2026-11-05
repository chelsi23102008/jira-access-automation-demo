import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

// Jira renders the form, so no React components or separate form are necessary.
// Use an external script rather than inline JavaScript to respect Forge's CSP.
await mkdir('build', { recursive: true });
await build({
  entryPoints: ['src/index.js'], outfile: 'build/app.js', bundle: true,
  minify: true, platform: 'browser', target: ['es2022']
});
await writeFile('build/index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Access Request field rules</title></head><body><script src="./app.js"></script></body></html>');
