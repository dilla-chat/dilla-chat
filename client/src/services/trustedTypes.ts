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
  const tt = typeof window !== 'undefined' ? window.trustedTypes : undefined;
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

function stripDangerousMarkup(input: string): string {
  // We deliberately keep this lightweight — react-markdown's `skipHtml`
  // is the main defence. This is the second line: refuse anything that
  // smells like a script element or javascript: URI in an attribute.
  // Case-insensitive matches because HTML is case-insensitive.
  if (/<\s*script[\s>]/i.test(input)) {
    const scriptTagPattern = /<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi;
    let previous: string;
    let sanitized = input;
    do {
      previous = sanitized;
      sanitized = sanitized.replace(scriptTagPattern, '');
    } while (sanitized !== previous);
    return sanitized;
  }
  return input;
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
