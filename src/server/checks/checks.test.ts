/**
 * Tests for the build checks. Run with:
 *   node --experimental-strip-types --test src/server/checks/*.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutoCheck, BuildFile } from '../../agency/types';
import { runChecks } from './index.ts';
import { lineAt, parseJson, stripJsonComments } from './shared.ts';

const GOOD_SECTION = `<section class="agfy-demo" aria-labelledby="agfy-demo-title-{{ section.id }}">
  <h2 id="agfy-demo-title-{{ section.id }}">{{ section.settings.heading | escape }}</h2>
  <p>{{ section.settings.text | escape }}</p>
</section>
{{ 'agfy-demo.css' | asset_url | stylesheet_tag }}
{% schema %}
{
  "name": "Demo feature",
  "settings": [
    { "type": "text", "id": "heading", "label": "Heading", "default": "Demo feature" },
    { "type": "text", "id": "text", "label": "Text", "default": "Scripted output." }
  ],
  "presets": [{ "name": "Demo feature" }]
}
{% endschema %}
`;
const GOOD_CSS = '.agfy-demo { padding: 2rem 0; }\n';
const GOOD: BuildFile[] = [
  { path: 'sections/agfy-demo.liquid', content: GOOD_SECTION },
  { path: 'assets/agfy-demo.css', content: GOOD_CSS },
];

/** A section with a valid schema around the given markup. */
const section = (markup: string, schema = '{ "name": "Test", "settings": [], "presets": [{ "name": "Test" }] }') =>
  `${markup}\n{% schema %}\n${schema}\n{% endschema %}\n`;

async function check(files: BuildFile[]): Promise<AutoCheck[]> {
  const out = await runChecks(files);
  assert.ok(out, 'runChecks returned null');
  return out;
}

function find(out: AutoCheck[], check: string, path?: string): AutoCheck {
  const hit = out.find((f) => f.check === check && (path === undefined || f.path === path));
  assert.ok(hit, `expected ${check}${path ? ` on ${path}` : ''}, got:\n${JSON.stringify(out, null, 2)}`);
  return hit;
}

describe('runChecks: clean builds', () => {
  it('reports nothing for the scripted section and its stylesheet', async () => {
    assert.deepEqual(await check(GOOD), []);
  });

  it('does not flag assets, snippets or translations that live outside the build', async () => {
    const out = await check([
      { path: 'sections/x.liquid', content: section(`<div>{{ 'theme-only.css' | asset_url | stylesheet_tag }}{% render 'theme-only-snippet' %}{{ 'products.product.add_to_cart' | t }}</div>`) },
      { path: 'templates/product.json', content: '{ "sections": { "main": { "type": "main-product" }, "x": { "type": "x" } }, "order": ["main", "x"] }' },
    ]);
    assert.deepEqual(out.filter((f) => f.severity !== 'info'), []);
  });

  it('accepts the comment header Shopify writes into JSON templates and locales', async () => {
    const out = await check([
      { path: 'templates/index.json', content: '/*\n * auto-generated\n */\n{ "sections": {}, "order": [] }' },
      { path: 'locales/en.default.json', content: '/* header */ { "general": { "hello": "Hello" } }' },
    ]);
    assert.deepEqual(out, []);
  });

  it('returns [] for an empty build', async () => {
    assert.deepEqual(await runChecks([]), []);
  });
});

describe('runChecks: Liquid and HTML (Theme Check)', () => {
  it('reports an unclosed {% if %} as a syntax error', async () => {
    const out = await check([{ path: 'sections/bad.liquid', content: section('<div>\n  {% if product.available %}\n  <p>In stock</p>\n</div>') }]);
    const f = find(out, 'LiquidHTMLSyntaxError', 'sections/bad.liquid');
    assert.equal(f.severity, 'error');
    assert.equal(f.line, 2);
  });

  it('reports an unknown filter on its line', async () => {
    const out = await check([{ path: 'sections/f.liquid', content: section('<p>\n  {{ product.title | shout }}\n</p>') }]);
    const f = find(out, 'UnknownFilter', 'sections/f.liquid');
    assert.equal(f.severity, 'error');
    assert.equal(f.line, 2);
  });

  it('reports the deprecated {% include %} tag', async () => {
    const out = await check([{ path: 'snippets/s.liquid', content: '<div>\n{% include "price" %}\n</div>' }]);
    const f = find(out, 'DeprecatedTag', 'snippets/s.liquid');
    assert.equal(f.severity, 'warning');
    assert.equal(f.line, 2);
  });

  it('reports parser-blocking scripts and remote assets', async () => {
    const out = await check([{ path: 'sections/s.liquid', content: section('<div></div>\n<script src="https://cdn.example.com/lib.js"></script>') }]);
    assert.equal(find(out, 'ParserBlockingScript', 'sections/s.liquid').line, 2);
    assert.equal(find(out, 'RemoteAsset', 'sections/s.liquid').line, 2);
  });

  it('reports an HTML element left open across a branch', async () => {
    const out = await check([{ path: 'snippets/u.liquid', content: '{% if a %}\n  <div class="x">\n{% endif %}\n{% if a %}\n  </span>\n{% endif %}\n' }]);
    find(out, 'UnclosedHTMLElement', 'snippets/u.liquid');
  });

  it('reports an img without width and height', async () => {
    const out = await check([{ path: 'snippets/i.liquid', content: '<p>x</p>\n<img src="{{ image | image_url: width: 400 }}" alt="">\n' }]);
    assert.equal(find(out, 'ImgWidthAndHeight', 'snippets/i.liquid').line, 2);
  });

  it('validates the schema against Shopify\'s JSON schema (bad setting type)', async () => {
    const out = await check([{ path: 'sections/t.liquid', content: section('<p>{{ section.settings.a }}</p>', '{\n  "name": "T",\n  "settings": [{ "type": "textt", "id": "a", "label": "A" }],\n  "presets": [{ "name": "T" }]\n}') }]);
    const f = find(out, 'ValidSchema', 'sections/t.liquid');
    assert.equal(f.severity, 'error');
    assert.equal(f.line, 5);
  });
});

describe('runChecks: JSON and schema (direct)', () => {
  it('reports a broken JSON template with its line', async () => {
    const out = await check([{ path: 'templates/product.json', content: '{\n  "sections": {\n    "main": { "type": "main-product" },\n  },\n  "order": ["main"]\n}' }]);
    const f = find(out, 'InvalidJSON', 'templates/product.json');
    assert.equal(f.severity, 'error');
    assert.equal(f.line, 4);
    assert.equal(out.filter((x) => x.path === 'templates/product.json').length, 1, 'Theme Check duplicates were not dropped');
  });

  it('reports a template whose order lists a missing section', async () => {
    const out = await check([{ path: 'templates/page.json', content: '{ "sections": { "a": { "type": "x" } }, "order": ["a", "b"] }' }]);
    assert.match(find(out, 'InvalidTemplate', 'templates/page.json').message, /"b"/);
  });

  it('reports a section without a schema', async () => {
    const out = await check([{ path: 'sections/plain.liquid', content: '<div>No schema</div>\n' }]);
    assert.equal(find(out, 'MissingSchema', 'sections/plain.liquid').severity, 'error');
  });

  it('reports invalid schema JSON on its line, once', async () => {
    const out = await check([{ path: 'sections/j.liquid', content: '<div></div>\n{% schema %}\n{\n  "name": "J",\n  "settings": [],\n}\n{% endschema %}\n' }]);
    const f = find(out, 'InvalidSchemaJSON', 'sections/j.liquid');
    assert.equal(f.line, 6);
    assert.equal(out.filter((x) => x.check === 'ValidSchema').length, 0);
  });

  it('reports schema shape problems: no name, duplicate ids, no type, no presets', async () => {
    const schema = '{\n  "settings": [\n    { "type": "text", "id": "a", "label": "A" },\n    { "type": "text", "id": "a", "label": "A again" },\n    { "id": "b", "label": "B" }\n  ]\n}';
    const out = await check([{ path: 'sections/s.liquid', content: section('<p>{{ section.settings.a }}</p>', schema) }]);
    assert.match(find(out, 'InvalidSchema', 'sections/s.liquid').message, /name|type/);
    assert.equal(find(out, 'DuplicateSettingId').line, 6);
    assert.ok(out.some((f) => f.check === 'InvalidSchema' && /"b" has no "type"/.test(f.message)));
    assert.equal(find(out, 'MissingPresets').severity, 'warning');
  });

  it('reports a reference to a setting the schema does not define', async () => {
    const out = await check([{ path: 'sections/r.liquid', content: section('<h2>{{ section.settings.heading }}</h2>\n<p>{{ section.settings.subheading }}</p>', '{ "name": "R", "settings": [{ "type": "text", "id": "heading", "label": "H" }], "presets": [{ "name": "R" }] }') }]);
    const f = find(out, 'UnknownSetting', 'sections/r.liquid');
    assert.equal(f.line, 2);
    assert.match(f.message, /subheading/);
  });

  it('checks theme blocks too', async () => {
    const out = await check([{ path: 'blocks/b.liquid', content: '<p {{ block.shopify_attributes }}>{{ block.settings.txt }}</p>\n' }]);
    find(out, 'MissingSchema', 'blocks/b.liquid');
  });
});

describe('runChecks: translations (direct)', () => {
  it('reports a missing key in a namespace the build defines, with its line', async () => {
    const out = await check([
      { path: 'locales/en.default.json', content: '{ "size_guide": { "title": "Size guide" } }' },
      { path: 'sections/g.liquid', content: section("<h2>{{ 'size_guide.title' | t }}</h2>\n<p>{{ 'size_guide.intro' | t }}</p>\n<p>{{ 'general.other' | t }}</p>") },
    ]);
    const missing = out.filter((f) => f.check === 'MissingTranslationKey');
    assert.equal(missing.length, 1, JSON.stringify(out, null, 2));
    assert.equal(missing[0].path, 'sections/g.liquid');
    assert.equal(missing[0].line, 2);
    assert.equal(missing[0].severity, 'warning');
  });

  it('reports keys of the default locale that another locale lacks, ignoring plural forms', async () => {
    const out = await check([
      { path: 'locales/en.default.json', content: '{ "g": { "a": "A", "b": "B", "items": { "one": "1 item", "other": "{{ count }} items" } } }' },
      { path: 'locales/ja.json', content: '{ "g": { "a": "A", "items": { "other": "{{ count }}" } } }' },
    ]);
    const f = find(out, 'MatchingTranslations', 'locales/ja.json');
    assert.match(f.message, /'g\.b'/);
    assert.doesNotMatch(f.message, /items/);
  });
});

describe('runChecks: robustness', () => {
  it('never throws on garbage and stays within the time limit', async () => {
    const garbage = [
      null, undefined, 42, 'x', {}, { path: 1, content: 2 }, { path: 'sections/x.liquid' },
      { path: 'sections/../../etc.liquid', content: '{% schema %}{% endschema %}{% if %}{{{{' },
      { path: 'templates/x.json', content: '\u0000￿' },
      { path: 'locales/en.default.json', content: '[1,2' },
      { path: 'sections/deep.liquid', content: '{% if a %}'.repeat(2000) },
      { path: 'snippets/big.liquid', content: '<div class="a">{{ x | upcase }}</div>\n'.repeat(5000) },
    ] as unknown as BuildFile[];
    const started = Date.now();
    const out = await runChecks(garbage);
    assert.ok(Array.isArray(out));
    assert.ok(Date.now() - started < 10_500);
    assert.ok(out.length <= 100);
    // Also when the input itself is not an array.
    assert.ok(Array.isArray(await runChecks(null as unknown as BuildFile[])));
  });

  it('keeps what it has when the time limit is reached', async () => {
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `snippets/s${i}.liquid`, content: '<p>{{ x | shout }}</p>\n'.repeat(2000) }));
    const started = Date.now();
    const out = await runChecks(files, { timeLimitMs: 50 });
    assert.ok(out);
    assert.ok(Date.now() - started < 2000);
    assert.ok(out.length <= 100);
  });

  it('summarizes repeats of a rule in one file', async () => {
    const content = Array.from({ length: 12 }, (_, j) => `{{ x | bogus_${j} }}`).join('\n');
    const out = await check([{ path: 'snippets/noisy.liquid', content }]);
    const unknown = out.filter((f) => f.check === 'UnknownFilter');
    assert.equal(unknown.length, 6);
    assert.match(unknown[5].message, /^7 more UnknownFilter findings/);
    assert.equal(unknown[5].line, 6);
  });

  it('caps the number of findings', async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ path: `snippets/s${i}.liquid`, content: Array.from({ length: 5 }, (_, j) => `{{ x | bogus_${j} }}`).join('\n') }));
    const out = await check(files);
    assert.equal(out.length, 100);
    assert.equal(out[out.length - 1].severity, 'info');
    assert.match(out[out.length - 1].message, /more findings/);
  });
});

describe('shared helpers', () => {
  it('blanks comments but keeps offsets and strings', () => {
    const src = '{ "a": "/* not a comment */", // trailing\n "b": 1 /* x */ }';
    const out = stripJsonComments(src);
    assert.equal(out.length, src.length);
    assert.deepEqual(JSON.parse(out), { a: '/* not a comment */', b: 1 });
  });

  it('gives the line of a JSON error', () => {
    const r = parseJson('{\n"a": 1,\n}');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.line, 3);
    assert.equal(lineAt('a\nb\nc', 4), 3);
  });
});
