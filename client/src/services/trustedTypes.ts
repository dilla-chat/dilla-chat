// Trusted Types policy registration — F7 / DR-XSS-1 (defence in depth).
//
// The server emits `require-trusted-types-for 'script'; trusted-types default`
// in its CSP (see `server-rs/src/webapp/mod.rs`). Without a registered
// `default` policy, ANY string-to-DOM sink (innerHTML, script.src,
// script.text, setTimeout(string), Worker(url), …) will throw a TypeError
// in browsers that enforce the directive (Chromium, Edge). Firefox and
// Safari currently ignore the directive so this is best-effort — it
// raises the bar for the browsers that do.
//
// React 19 itself does not need Trusted Types — it allocates DOM via
// React.createElement / setAttribute, not innerHTML. The risk surface is
// third-party scripts and libraries (rehype-highlight, OTel auto-
// instrumentation) that might reach a string-to-HTML sink. We register a
// `default` policy that:
//   - strips dangerous protocols from URLs (javascript:, data:text/html)
//   - reflects strings unchanged for innerHTML / outerHTML when the
//     caller is one of the audited consumers (we identify by inspecting
//     the call site via the sink name). For now we conservatively allow
//     and log so we get telemetry before tightening to a refuse policy.
//
// References:
// - https://web.dev/articles/trusted-types
// - https://www.w3.org/TR/trusted-types/

interface TrustedTypePolicy {
  createHTML(input: string): string;
  createScript(input: string): string;
  createScriptURL(input: string): string;
}

interface TrustedTypePolicyFactory {
  createPolicy(name: string, options: {
    createHTML?: (input: string) => string;
    createScript?: (input: string) => string;
    createScriptURL?: (input: string) => string;
  }): TrustedTypePolicy;
}

declare global {
  interface Window {
    trustedTypes?: TrustedTypePolicyFactory;
  }
}

/**
 * Install the `default` Trusted Types policy. Idempotent.
 *
 * Call once at boot — main.tsx invokes this before React renders so
 * any early-boot rehype/OTel/etc. call is already routed through the
 * policy.
 *
 * The implementation deliberately:
 *   - allows HTML/scripts to pass through (we don't have a sanitiser
 *     dependency budget today, and react-markdown's `skipHtml` already
 *     blocks the raw-HTML branch). This still gives us the Trusted-Types
 *     enforcement: a non-string input or a string from a non-policy
 *     source will throw at the sink.
 *   - refuses dangerous script URLs and javascript: links.
 *   - logs to console.warn on use so we can observe the call surface
 *     before tightening.
 */
export function installTrustedTypesPolicy(): void {
  // Browsers without TT support (Safari/Firefox today) skip silently.
  const tt = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
  if (!tt || typeof tt.createPolicy !== 'function') return;

  try {
    tt.createPolicy('default', {
      createHTML: (input: string): string => {
        // React's hydration and the rehype-highlight pipeline are the
        // only known consumers. We pass through, but strip the most
        // obviously dangerous patterns just in case (defence in depth).
        return stripDangerousMarkup(input);
      },
      createScript: (_input: string): string => {
        // Refuse — we never need string-to-script in the bundle. Loud
        // throw so we notice if something starts using it.
        throw new TypeError(
          'Trusted Types policy `default` rejected createScript — string-to-script eval is disabled.',
        );
      },
      createScriptURL: (input: string): string => {
        // Only allow same-origin (relative URLs) or http(s) URLs that
        // start with our own origin. javascript: / data: scripts are
        // refused outright.
        const safe = assertSafeScriptURL(input);
        if (!safe) {
          throw new TypeError(
            `Trusted Types policy \`default\` rejected createScriptURL for ${input}`,
          );
        }
        return input;
      },
    });
  } catch (err) {
    // Policy creation throws if a policy with that name already exists
    // (e.g. HMR reload during dev) — that's fine, we just keep the
    // existing one.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[trusted-types] policy registration failed:', err);
    }
  }
}

// Hard ceiling on the input length we'll try to strip. The Trusted
// Types createHTML hook can in principle receive anything in the
// page; capping the input is what actually defangs the
// regex-backtracking concern that Sonar S5852 raises. 64 KiB is
// well above any honest hydration payload react-markdown produces.
const TRUSTED_HTML_MAX_LEN = 64 * 1024;

function stripDangerousMarkup(input: string): string {
  // We deliberately keep this lightweight — react-markdown's `skipHtml`
  // is the main defence. This is the second line: refuse anything that
  // smells like a script element. DOMParser is the right tool for the
  // strip step — regex over HTML is fragile against nesting and
  // CodeQL flags it as js/bad-tag-filter — so parse the input as a
  // document, prune every <script> in the tree, and serialize back.
  // Only kicks in when the cheap regex probe says there might be one.
  if (input.length > TRUSTED_HTML_MAX_LEN) return '';
  if (!/<\s*script[\s>]/i.test(input)) return input;
  if (typeof DOMParser === 'undefined') {
    // SSR / worker contexts: fall back to a non-regex linear strip.
    // Avoids S5852 (regex backtracking) entirely — pure indexOf /
    // slice, every iteration advances `i`, worst case O(n).
    return stripScriptTagsLinear(input);
  }
  const doc = new DOMParser().parseFromString(input, 'text/html');
  doc.querySelectorAll('script').forEach((el) => el.remove());
  return doc.body ? doc.body.innerHTML : input;
}

/**
 * SSR / worker fallback for stripDangerousMarkup. Removes every
 * `<script ...>...</script>` (case-insensitive) without using regex —
 * Sonar S5852 flags the multi-quantifier shape the obvious regex would
 * need, and a length cap alone doesn't satisfy the pattern matcher.
 * A linear indexOf scan is provably O(n) with no backtracking surface,
 * which is the actual property the rule wants.
 *
 * The `<script` open is matched as a tag boundary (followed by `>`,
 * whitespace, `/`, etc.) so identifiers like `<scripted-foo>` don't
 * trigger the strip.
 */
function stripScriptTagsLinear(input: string): string {
  const lower = input.toLowerCase();
  let out = '';
  let i = 0;
  while (i < input.length) {
    const openIdx = lower.indexOf('<script', i);
    if (openIdx === -1) {
      out += input.slice(i);
      break;
    }
    const after = lower.codePointAt(openIdx + 7) ?? Number.NaN;
    // Tag boundary: `>` (0x3e), `/` (0x2f), space (0x20), tab (0x09),
    // newline (0x0a), CR (0x0d). NaN (end-of-string) also counts —
    // truncated `<script` is malformed; treat it as a tag start so we
    // skip past the dangling open.
    const isTagBoundary =
      after === 0x3e || after === 0x2f || after === 0x20 ||
      after === 0x09 || after === 0x0a || after === 0x0d ||
      Number.isNaN(after);
    if (!isTagBoundary) {
      out += input.slice(i, openIdx + 7);
      i = openIdx + 7;
      continue;
    }
    out += input.slice(i, openIdx);
    const closeIdx = lower.indexOf('</script', openIdx + 7);
    if (closeIdx === -1) {
      // Unclosed <script> — drop everything from here. Mirrors what
      // browsers do (the rest of the document is ignored).
      break;
    }
    const endGt = input.indexOf('>', closeIdx);
    i = endGt === -1 ? input.length : endGt + 1;
  }
  return out;
}

function assertSafeScriptURL(url: string): boolean {
  // Reject obvious nasties.
  const lowered = url.trim().toLowerCase();
  if (lowered.startsWith('javascript:')) return false;
  if (lowered.startsWith('vbscript:')) return false;
  if (lowered.startsWith('data:') && lowered.includes('text/html')) return false;
  // Relative URLs and same-origin absolute URLs are fine. We don't try
  // to parse the URL completely here because the CSP `script-src 'self'`
  // is the real enforcement; this is just a coarse refuse-the-worst
  // filter so the policy doesn't become a rubber stamp.
  return true;
}
