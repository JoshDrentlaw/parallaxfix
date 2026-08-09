/**
 * Static guard against a mistake we've now shipped twice: the page's CSP
 * (style-src 'self', no unsafe-inline/nonce — src/web/server.ts's CSP
 * constant, SECURITY.md §5) silently drops ANY inline style — a style="..."
 * attribute, an el() call with a style: key, or element.style.foo = ... —
 * with no thrown error, just a console warning easy to miss. Both the tuning
 * histogram bars and the info-chip popover's edge nudge shipped broken this
 * way before anyone noticed live. This test greps the static source for the
 * pattern instead of waiting to catch it in a browser console a third time.
 *
 * Not a substitute for the CSP violation-report endpoint (POST
 * /api/csp-report, src/web/server.ts) — that catches every directive, live,
 * for real users. This catches only the inline-style mistake specifically,
 * but does it before merge, with no browser required.
 */

import { assertEquals } from "@std/assert";

const APP_JS = await Deno.readTextFile(
  new URL("../src/web/static/app.js", import.meta.url),
);
const INDEX_HTML = await Deno.readTextFile(
  new URL("../src/web/static/index.html", import.meta.url),
);

function findLines(source: string, pattern: RegExp): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    if (pattern.test(line)) hits.push(`  line ${i + 1}: ${line.trim()}`);
  });
  return hits;
}

Deno.test("app.js: no `style:` key in an el() attrs object (use a CSS class instead)", () => {
  const hits = findLines(APP_JS, /\bstyle\s*:/);
  assertEquals(
    hits,
    [],
    `Found inline style: key(s) — the CSP drops these silently:\n${hits.join("\n")}`,
  );
});

Deno.test("app.js: no `.style.<prop> =` assignment (use classList instead)", () => {
  const hits = findLines(APP_JS, /\.style\.\w+\s*=/);
  assertEquals(
    hits,
    [],
    `Found .style.<prop> = assignment(s) — the CSP drops these silently:\n${hits.join("\n")}`,
  );
});

Deno.test('app.js: no setAttribute("style", ...) call', () => {
  const hits = findLines(APP_JS, /setAttribute\(\s*["'`]style["'`]/);
  assertEquals(
    hits,
    [],
    `Found setAttribute("style", ...) call(s) — the CSP drops these silently:\n${hits.join("\n")}`,
  );
});

Deno.test('index.html: no inline style="..." attribute', () => {
  const hits = findLines(INDEX_HTML, /\sstyle\s*=\s*["']/);
  assertEquals(
    hits,
    [],
    `Found inline style="..." attribute(s) — the CSP drops these silently:\n${hits.join("\n")}`,
  );
});
