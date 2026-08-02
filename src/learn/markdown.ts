/**
 * Minimal markdown → HTML for dxkit's OWN curated docs (`docs/learn/*.md`).
 *
 * Deliberately NOT a general markdown engine: it renders exactly the subset
 * those docs use (h1–h4, paragraphs, flat unordered/ordered lists, fenced
 * code, blockquotes, inline code, bold, links) and HTML-escapes everything
 * else. The learn page must be fully self-contained with zero dependencies
 * and zero CDN loads (the dashboard's remote `marked.js` + `<pre>` fallback
 * is the exact class this avoids), and the docs + this renderer live in one
 * repo and evolve together — `test/learn/markdown.test.ts` pins the subset.
 * If a doc ever needs a construct this can't render, extend the renderer and
 * its test in the same change; do not reach for a CDN.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline transforms, applied to already-escaped text: `code`, **bold**, [t](url). */
function renderInline(escaped: string): string {
  let out = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Links: only http(s) and repo-relative targets; anything else stays text.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, href: string) => {
    if (/^(https?:\/\/|#|\.{0,2}\/)/.test(href) || /^[\w./-]+$/.test(href)) {
      return `<a href="${href}">${text}</a>`;
    }
    return m;
  });
  return out;
}

/** Stable anchor id for a heading (nav links). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  /** Open paragraph line buffer. */
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length > 0) {
      out.push(`<p>${renderInline(escapeHtml(para.join(' ')))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: verbatim (escaped), no inline transforms.
    if (/^```/.test(line)) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence (or EOF)
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // Headings h1–h4.
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      const text = h[2];
      out.push(`<h${level} id="${slugify(text)}">${renderInline(escapeHtml(text))}</h${level}>`);
      i++;
      continue;
    }

    // Lists (flat). A continuation line (indented, non-list) appends to the
    // previous item — the docs wrap long list items across lines.
    const isUl = (l: string): boolean => /^[-*]\s+/.test(l);
    const isOl = (l: string): boolean => /^\d+\.\s+/.test(l);
    if (isUl(line) || isOl(line)) {
      flushPara();
      const ordered = isOl(line);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (ordered ? isOl(l) : isUl(l)) {
          items.push(l.replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, ''));
          i++;
        } else if (/^\s+\S/.test(l) && items.length > 0) {
          items[items.length - 1] += ` ${l.trim()}`;
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(
        `<${tag}>${items.map((it) => `<li>${renderInline(escapeHtml(it))}</li>`).join('')}</${tag}>`,
      );
      continue;
    }

    // Blockquote (flat).
    if (/^>\s?/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote><p>${renderInline(escapeHtml(quote.join(' ')))}</p></blockquote>`);
      continue;
    }

    // Blank line: paragraph boundary.
    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join('\n');
}
