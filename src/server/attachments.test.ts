/** Attachment sniffing, limits, storage round-trip and the headers they are served with. */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'agentify-attachments-'));
process.env.AGENTIFY_DATA_DIR = dir;
const { cleanName, loadAttachment, resolveAttachments, saveAttachment, serveHeaders, sniff, MAX_IMAGE_BYTES } = await import('./attachments');
after(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set(bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 13], 'IHDR'));
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

// SOI, an APP0 segment, then a baseline frame header: height 600, width 800.
const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const gif = bytes('GIF89a', [0x40, 0x01, 0xf0, 0x00], [0, 0, 0]);
const webpX = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', [10, 0, 0, 0], [0, 0, 0, 0], [0x7f, 0x07, 0x00], [0x37, 0x04, 0x00], [0, 0]);
const webpLossy = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], [0x80, 0x02], [0xe0, 0x01], [0, 0]);

describe('sniff', () => {
  test('reads image types and dimensions from the header bytes', () => {
    assert.deepEqual(sniff(png(1600, 900), 'x.bin'), { type: 'image/png', width: 1600, height: 900 });
    assert.deepEqual(sniff(jpeg, 'x'), { type: 'image/jpeg', width: 800, height: 600 });
    assert.deepEqual(sniff(gif, 'x'), { type: 'image/gif', width: 320, height: 240 });
    assert.deepEqual(sniff(webpX, 'x'), { type: 'image/webp', width: 1920, height: 1080 });
    assert.deepEqual(sniff(webpLossy, 'x'), { type: 'image/webp', width: 640, height: 480 });
  });

  test('ignores the claimed type and extension for binary formats', () => {
    assert.equal(sniff(png(1, 1), 'evil.html')?.type, 'image/png');
    assert.equal(sniff(bytes('%PDF-1.7\n'), 'doc.txt')?.type, 'application/pdf');
  });

  test('refuses SVG, HTML and unknown binaries', () => {
    assert.equal(sniff(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'a.svg'), null);
    assert.equal(sniff(bytes('<html><script>alert(1)</script>'), 'a.html'), null);
    assert.equal(sniff(bytes([0x7f], 'ELF', [2, 1, 1]), 'a.txt'), null);
  });

  test('accepts UTF-8 text with a known extension only', () => {
    assert.equal(sniff(bytes('{"a":1}'), 'data.json')?.type, 'application/json');
    assert.equal(sniff(bytes('{% if x %}{% endif %}'), 'card.liquid')?.type, 'text/x-liquid');
    assert.equal(sniff(bytes([0xc3, 0x28]), 'bad.txt'), null);
    assert.equal(sniff(bytes('a', [0], 'b'), 'nul.txt'), null);
  });
});

describe('storage', () => {
  test('round-trips bytes across chunks and scopes them to the workspace', async () => {
    const big = new Uint8Array(700 * 1024);
    big.set(png(4000, 3000));
    for (let i = 33; i < big.length; i++) big[i] = i % 251;
    const a = await saveAttachment('ws1', { name: '../../shot.png', type: 'text/html', bytes: big });
    assert.equal(a.name, 'shot.png');
    assert.equal(a.type, 'image/png');
    assert.equal(a.width, 4000);
    const back = await loadAttachment('ws1', a.id);
    assert.deepEqual(back.bytes, big);
    await assert.rejects(loadAttachment('ws2', a.id), { status: 404 });
    assert.deepEqual(await resolveAttachments('ws1', [a.id, 'nope', 42]), [a]);
    assert.deepEqual(await resolveAttachments('ws2', [a.id]), []);
  });

  test('enforces the per-file limits and refuses empty files', async () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    huge.set(png(10, 10));
    await assert.rejects(saveAttachment('ws1', { name: 'a.png', type: 'image/png', bytes: huge }), { status: 413 });
    await assert.rejects(saveAttachment('ws1', { name: 'a.txt', type: 'text/plain', bytes: new Uint8Array(600 * 1024).fill(97) }), { status: 413 });
    await assert.rejects(saveAttachment('ws1', { name: 'a.txt', type: 'text/plain', bytes: new Uint8Array() }), { status: 400 });
    await assert.rejects(saveAttachment('ws1', { name: 'a.svg', type: 'image/svg+xml', bytes: bytes('<svg/>') }), { status: 415 });
  });
});

describe('serving', () => {
  test('images inline, everything else as an inert download', () => {
    const img = serveHeaders({ id: 'x', name: 'shot.png', type: 'image/png', size: 10 });
    assert.equal(img['Content-Type'], 'image/png');
    assert.match(img['Content-Disposition']!, /^inline;/);
    assert.equal(img['X-Content-Type-Options'], 'nosniff');
    assert.match(img['Content-Security-Policy']!, /default-src 'none'.*sandbox/);

    const js = serveHeaders({ id: 'x', name: 'app "1".js', type: 'text/javascript', size: 10 });
    assert.equal(js['Content-Type'], 'text/plain; charset=utf-8');
    assert.match(js['Content-Disposition']!, /^attachment; filename="app _1_\.js"; filename\*=UTF-8''app%20%221%22\.js$/);
    assert.equal(serveHeaders({ id: 'x', name: 'a.pdf', type: 'application/pdf', size: 1 })['Content-Disposition']!.split(';')[0], 'attachment');
  });

  test('cleanName strips paths, control characters and quotes', () => {
    assert.equal(cleanName('C:\\Users\\me\\"shot"\n.png'), 'shot.png');
    assert.equal(cleanName('   '), 'file');
  });
});
