// Post-build SRI emitter — F2 / DR-SUPPLY-1 / EMB-INTEG-1.
//
// Walks dist/index.html, computes SHA-384 over every referenced
// <script> and <link rel="stylesheet" | "modulepreload"> whose
// src / href points at a local asset under dist/, and rewrites
// the tag in place to include integrity="sha384-..." and
// crossorigin="anonymous".
//
// Why a tiny script instead of vite-plugin-sri4:
// - Vite plugin ecosystem moves quickly; pinning a tiny script avoids
//   transitive supply-chain creep (architecture review §8.4 bullet 3).
// - We only run after `vite build`, so we operate on the final
//   dist/ output without poking into Rollup internals.
//
// Caveats:
// - We only rewrite tags whose URL resolves to an existing local file.
//   Cross-origin scripts (none today; SRI without crossorigin is no-op)
//   are left untouched.
// - Inline <script> tags are not hashed (there shouldn't be any —
//   F1 CSP forbids them; this script asserts that and fails the build
//   if it finds one).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const distDir = path.join(__dirname, '..', 'dist');
const indexPath = path.join(distDir, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.warn('[sri] ' + indexPath + ' not found - did Vite build run?');
  process.exit(0);
}

let html = fs.readFileSync(indexPath, 'utf8');
let rewrites = 0;
let skipped = 0;

// Fail loud on inline scripts - F1 CSP forbids them.
const inlineScriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const inlineMatch = inlineScriptRe.exec(html);
if (inlineMatch && inlineMatch[1].trim().length > 0) {
  console.error(
    '[sri] inline <script> found in dist/index.html - CSP forbids it.\n' +
      '      Move the inline code into a separate .ts file. Offending block:\n' +
      '      ' + inlineMatch[0].slice(0, 200),
  );
  process.exit(1);
}

function sha384Of(localPath) {
  const buf = fs.readFileSync(localPath);
  const digest = crypto.createHash('sha384').update(buf).digest('base64');
  return 'sha384-' + digest;
}

function resolveLocal(urlAttr) {
  // Vite emits absolute paths starting with "/assets/...". Strip the
  // leading slash so we can resolve against dist/.
  if (!urlAttr) return null;
  if (urlAttr.startsWith('http://') || urlAttr.startsWith('https://')) {
    // Cross-origin - would need crossorigin=anonymous + the remote
    // server to set CORS headers. We don't ship any today, so skip.
    return null;
  }
  const cleaned = urlAttr.split('?')[0].split('#')[0];
  const rel = cleaned.startsWith('/') ? cleaned.slice(1) : cleaned;
  const full = path.join(distDir, rel);
  return fs.existsSync(full) ? full : null;
}

function rewriteAttr(tagStr, attrName, newValue) {
  const re = new RegExp('\\s' + attrName + '="[^"]*"', 'i');
  if (re.test(tagStr)) {
    return tagStr.replace(re, ' ' + attrName + '="' + newValue + '"');
  }
  return tagStr.replace(/(\s*\/?)>$/, ' ' + attrName + '="' + newValue + '"$1>');
}

function addIntegrity(tagStr, urlAttrName) {
  const urlRe = new RegExp(urlAttrName + '="([^"]+)"', 'i');
  const urlMatch = urlRe.exec(tagStr);
  if (!urlMatch) return tagStr;
  const local = resolveLocal(urlMatch[1]);
  if (!local) {
    skipped += 1;
    return tagStr;
  }

  // Skip if integrity is already present (idempotent re-runs).
  if (/\bintegrity="/.test(tagStr)) return tagStr;

  const digest = sha384Of(local);
  let next = rewriteAttr(tagStr, 'integrity', digest);
  if (!/\bcrossorigin=/.test(next)) {
    next = rewriteAttr(next, 'crossorigin', 'anonymous');
  }
  rewrites += 1;
  return next;
}

// <script src="..."> - type="module", crossorigin, etc. are tolerated.
html = html.replace(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/gi, function (tag) {
  return addIntegrity(tag, 'src');
});

// <link rel="stylesheet" href="...">
// <link rel="modulepreload" href="...">  (Vite emits these for code-split chunks)
html = html.replace(/<link\b[^>]*\brel="(?:stylesheet|modulepreload|preload)"[^>]*>/gi, function (tag) {
  return addIntegrity(tag, 'href');
});

fs.writeFileSync(indexPath, html);
console.log('[sri] rewrote ' + rewrites + ' tag(s) in ' + indexPath + ' (skipped ' + skipped + ' non-local)');
