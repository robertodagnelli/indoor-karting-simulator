#!/usr/bin/env node
/**
 * Production GitHub Pages build: minify + obfuscate the play-only site.
 * Local authoring files (track_editor.html) are not included.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CleanCSS from 'clean-css';
import { minify as minifyHtml } from 'html-minifier-terser';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { minify as minifyJs } from 'terser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');
const SOURCE_URL = 'https://github.com/robertodagnelli/indoor-karting-simulator';
const RESERVED = ['THREE', 'TrackLib', 'TracksStore'];

function sha10(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

async function copyFile(rel) {
  await fs.copyFile(path.join(ROOT, rel), path.join(OUT, rel));
}

async function obfuscateBundle(code) {
  const minified = await minifyJs(code, {
    compress: {
      passes: 2,
      drop_console: false,
      pure_getters: true
    },
    mangle: { reserved: RESERVED },
    format: { comments: false },
    ecma: 2018,
    module: false
  });
  if (!minified.code) throw new Error(minified.error || 'terser produced empty output');

  // Identifier mangling + string packing. No control-flow flattening:
  // that would add per-frame cost in the physics loop.
  return JavaScriptObfuscator.obfuscate(minified.code, {
    compact: true,
    target: 'browser',
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    reservedNames: RESERVED.map((n) => `^${n}$`),
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.4,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    splitStrings: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    transformObjectKeys: false,
    unicodeEscapeSequence: false
  }).getObfuscatedCode();
}

function extractAndStripScripts(html) {
  const inline = [];
  const next = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
    if (/\bsrc\s*=/.test(attrs)) {
      if (/track_lib\.js|tracks_store\.js/.test(attrs)) return '';
      return full;
    }
    inline.push(body);
    return '<!--APP_SCRIPT-->';
  });
  return { html: next, inline: inline.join('\n;\n') };
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'tracks'), { recursive: true });

  const htmlIn = await fs.readFile(path.join(ROOT, 'gokart_simulator.html'), 'utf8');
  const lib = await fs.readFile(path.join(ROOT, 'track_lib.js'), 'utf8');
  const store = await fs.readFile(path.join(ROOT, 'tracks_store.js'), 'utf8');

  const { html: withoutLocalScripts, inline } = extractAndStripScripts(htmlIn);
  if (!inline.trim()) throw new Error('No inline simulator script found');

  const app = await obfuscateBundle(`${lib}\n${store}\n${inline}`);
  const appName = `app.${sha10(app)}.js`;
  await fs.writeFile(path.join(OUT, appName), app);

  let html = withoutLocalScripts
    .replace(/<a class="editorLink"[^>]*>[\s\S]*?<\/a>/, '')
    .replace('<!--APP_SCRIPT-->', `<script src="${appName}"></script>`);

  html = html.replace(/<style>([\s\S]*?)<\/style>/i, (_, css) => {
    const out = new CleanCSS({ level: 2 }).minify(css);
    if (out.errors && out.errors.length) {
      throw new Error('CSS minify failed: ' + out.errors.join('; '));
    }
    return `<style>${out.styles}</style>`;
  });

  html = await minifyHtml(html, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    minifyCSS: false,
    minifyJS: false,
    removeRedundantAttributes: true
  });

  html = `<!-- Indoor Karting Simulator. Copyright (C) 2026 Roberto Dagnelli. AGPL-3.0-or-later. Source: ${SOURCE_URL} -->\n` + html;
  await fs.writeFile(path.join(OUT, 'index.html'), html);

  await copyFile('iks-logo.png');
  await copyFile('iks-hero.png');
  await copyFile('wheel-drift-sound-effect.mp3');
  await copyFile('LICENSE');

  const trackDir = path.join(ROOT, 'tracks');
  for (const name of await fs.readdir(trackDir)) {
    if (!name.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(trackDir, name), 'utf8');
    const compact = JSON.stringify(JSON.parse(raw));
    await fs.writeFile(path.join(OUT, 'tracks', name), compact);
  }

  const files = await fs.readdir(OUT, { recursive: true });
  console.log('Built play-only site in _site/');
  console.log('  ' + files.filter((f) => !f.startsWith('.')).sort().join('\n  '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
