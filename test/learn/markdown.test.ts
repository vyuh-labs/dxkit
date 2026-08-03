/**
 * Pins the markdown SUBSET the learn renderer supports (src/learn/markdown.ts).
 * The curated docs and this renderer evolve together; a doc that needs a new
 * construct extends the renderer AND this test in the same change.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { escapeHtml, markdownToHtml, slugify } from '../../src/learn/markdown';

describe('learn markdown renderer — the pinned subset', () => {
  it('renders h1–h4 with stable anchor ids', () => {
    const html = markdownToHtml('# Top\n\n## Mid section\n\n### Deep\n\n#### Deeper');
    expect(html).toContain('<h1 id="top">Top</h1>');
    expect(html).toContain('<h2 id="mid-section">Mid section</h2>');
    expect(html).toContain('<h3 id="deep">Deep</h3>');
    expect(html).toContain('<h4 id="deeper">Deeper</h4>');
  });

  it('joins consecutive lines into one paragraph; blank line splits', () => {
    const html = markdownToHtml('one\ntwo\n\nthree');
    expect(html).toContain('<p>one two</p>');
    expect(html).toContain('<p>three</p>');
  });

  it('renders flat ul and ol, with indented continuation lines folded in', () => {
    const html = markdownToHtml('- alpha\n- beta\n  continues\n\n1. first\n2. second');
    expect(html).toContain('<ul><li>alpha</li><li>beta continues</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
  });

  it('renders fenced code verbatim: escaped, no inline transforms', () => {
    const html = markdownToHtml('```\nnpx foo --bar **not bold** <tag>\n```');
    expect(html).toContain('<pre><code>npx foo --bar **not bold** &lt;tag&gt;</code></pre>');
  });

  it('renders inline code, bold, and safe links', () => {
    const html = markdownToHtml(
      'run `cmd` with **care**, see [docs](https://example.com) and [local](docs/learn/how-dxkit-thinks.md)',
    );
    expect(html).toContain('<code>cmd</code>');
    expect(html).toContain('<strong>care</strong>');
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expect(html).toContain('<a href="docs/learn/how-dxkit-thinks.md">local</a>');
  });

  it('refuses non-http(s), non-relative link targets', () => {
    const html = markdownToHtml('[x](javascript:alert(1))');
    expect(html).not.toContain('<a href="javascript:');
  });

  it('renders pipe tables (header + separator + body), cells inline-formatted', () => {
    const html = markdownToHtml(
      '| Rung | You write |\n| ---- | --------- |\n| 1 | a `key` |\n| 2 | **bold** |',
    );
    expect(html).toContain('<table><thead><tr><th>Rung</th><th>You write</th></tr></thead>');
    expect(html).toContain('<td>1</td><td>a <code>key</code></td>');
    expect(html).toContain('<td><strong>bold</strong></td>');
  });

  it('escapes raw HTML everywhere', () => {
    const html = markdownToHtml('<script>alert(1)</script>\n\n> a <b>quote</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<blockquote><p>a &lt;b&gt;quote&lt;/b&gt;</p></blockquote>');
  });

  it('escapeHtml + slugify behave', () => {
    expect(escapeHtml('a<b>&"c')).toBe('a&lt;b&gt;&amp;&quot;c');
    expect(slugify('What dxkit verifies, and what it cannot')).toBe(
      'what-dxkit-verifies-and-what-it-cannot',
    );
  });

  it('renders every shipped learn doc without dropping content into raw text', () => {
    // Smoke over the real docs: every heading line becomes a heading tag.
    const dir = path.join(__dirname, '..', '..', 'docs', 'learn');
    for (const f of fs.readdirSync(dir).filter((x: string) => x.endsWith('.md'))) {
      const md = fs.readFileSync(path.join(dir, f), 'utf-8');
      const html = markdownToHtml(md);
      const headingCount = (md.match(/^#{1,4}\s/gm) ?? []).length;
      const renderedHeadings = (html.match(/<h[1-4] /g) ?? []).length;
      expect(renderedHeadings, `${f}: headings dropped`).toBe(headingCount);
      expect(html, `${f}: unescaped angle bracket`).not.toMatch(
        /<(?!\/?(h[1-4]|p|ul|ol|li|pre|code|strong|a|blockquote|table|thead|tbody|tr|th|td)\b)[a-z]/i,
      );
    }
  });
});
