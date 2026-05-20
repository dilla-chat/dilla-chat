import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
// Atom One Dark + Light themes ship with highlight.js. The selector
// override in MessageMarkdown.css picks the right palette based on
// `<html data-theme>`; this import only adds tokens, not a colour
// scheme per se.
import 'highlight.js/styles/atom-one-dark.css';
import './MessageMarkdown.css';

interface MemberLite {
  id?: string;
  name?: string;
  username?: string;
}

interface Props {
  /** Raw message body. We pre-process @mentions and let react-markdown
   *  handle the rest. */
  text: string;
  /** Members in the current view, used to highlight your own mentions. */
  members?: Array<MemberLite> | { byId?: Record<string, MemberLite> };
  /** Current user id — when set, @-of-this-user gets the "mine" style. */
  currentUserId?: string | null;
  /** Display name (or username) of the current user, since @mentions
   *  reference the user by handle, not id. */
  currentUserHandle?: string | null;
}

const IMG_EXT = /\.(gif|png|jpe?g|webp|avif)(\?|$)/i;

// `@everyone` and `@here` are special broadcast mentions. Everything else
// is treated as a per-user mention regardless of whether the handle
// actually resolves — the user typing @nobody still gets the same chip
// (so we don't have to plumb the full member list into every call).
function isBroadcastHandle(handle: string) {
  return handle === 'everyone' || handle === 'here';
}

/**
 * Pre-process body text so @mentions become standard markdown links with
 * a custom `dilla:mention/` scheme. The `<a>` renderer below detects that
 * scheme and produces the mention chip instead of an anchor. This avoids
 * a custom remark plugin and keeps the rest of the markdown pipeline
 * unchanged.
 *
 * The regex matches mentions that aren't part of an email address: an
 * `@` preceded by start-of-string / whitespace / punctuation. We escape
 * `]` in the link text since markdown's link parser would otherwise
 * choke on `[@odd]name]`.
 */
function injectMentionLinks(body: string): string {
  return body.replace(/(^|[\s(,.;:!?])@([A-Za-z0-9_.-]+)/g, (_match, lead, handle) => {
    return `${lead}[@${handle.replace(/]/g, '\\]')}](dilla:mention/${encodeURIComponent(handle)})`;
  });
}

export default function MessageMarkdown({
  text,
  currentUserId,
  currentUserHandle,
}: Props): React.ReactElement | null {
  if (!text) return null;
  const prepared = React.useMemo(() => injectMentionLinks(text), [text]);

  const components: Components = React.useMemo(() => ({
    a({ href, children, ...rest }) {
      if (typeof href === 'string' && href.startsWith('dilla:mention/')) {
        const handle = decodeURIComponent(href.slice('dilla:mention/'.length));
        const broad = isBroadcastHandle(handle);
        const mine = !broad && !!currentUserHandle && handle === currentUserHandle;
        return (
          <span
            className={
              'ic ic-mention' +
              (mine ? ' ic-mention-mine' : '') +
              (broad ? ' ic-mention-broad' : '')
            }
            data-user-id={currentUserId && mine ? currentUserId : undefined}
          >
            {children}
          </span>
        );
      }
      // External link — open in a new tab. Image URLs render inline as an
      // <img>, matching the previous renderText behaviour so giphy /
      // direct-image links still embed.
      if (typeof href === 'string' && /^https?:\/\//i.test(href) && IMG_EXT.test(href.split('?')[0])) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
            <img
              src={href}
              alt={Array.isArray(children) ? children.join('') : String(children ?? href)}
              className="mm-inline-image"
            />
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="ic-link" {...rest}>
          {children}
        </a>
      );
    },
    // Pre-existing chat code-block styles use `.code-block` + `.cb-lang`.
    // Keep that visual contract so the existing CSS still applies.
    pre({ children, ...rest }) {
      return (
        <pre className="code-block" {...rest}>
          {children}
        </pre>
      );
    },
    code({ className, children, ...rest }) {
      // rehype-highlight adds 'hljs' + 'language-X' (and sometimes
      // detected variants) to fenced code blocks; inline code stays
      // class-less. Treat any `language-` class as the language label.
      const classes = (className || '').split(/\s+/);
      const langClass = classes.find((c) => c.startsWith('language-'));
      const inline = !langClass && !classes.includes('hljs');
      if (inline) return <code {...rest}>{children}</code>;
      const lang = langClass ? langClass.slice('language-'.length) : '';
      return (
        <>
          {lang && <span className="cb-lang">{lang}</span>}
          <code className={className} {...rest}>
            {children}
          </code>
        </>
      );
    },
    // Soft-block whatever HTML survived (skipHtml below also strips raw
    // HTML); paragraphs render unchanged so existing line-height kicks in.
    table({ children, ...rest }) {
      return (
        <div className="mm-table-wrap">
          <table {...rest}>{children}</table>
        </div>
      );
    },
  }), [currentUserId, currentUserHandle]);

  return (
    <div className="mm-root">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
        skipHtml
        // Headings feel wrong in a chat bubble — strip them but keep
        // their inner text so `# foo` just renders as `foo` instead of
        // a giant 2rem line.
        disallowedElements={['h1', 'h2', 'h3', 'h4', 'h5', 'h6']}
        unwrapDisallowed
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}
