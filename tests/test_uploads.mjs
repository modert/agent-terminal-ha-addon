import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createUploadStore, safeName, serve } from '../agent-terminal/rootfs/opt/agent-terminal/uploads.mjs';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'uploads-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = () => new Date(2026, 9, 2, 15, 30, 12);
  return { root, store: createUploadStore({ root, now, ...options }) };
}
const b64 = text => Buffer.from(text).toString('base64');
const files = root => readdirSync(root, { recursive: true }).filter(name => !statSync(join(root, name)).isDirectory());

test('names become one plain path segment an agent can read back verbatim', () => {
  for (const [input, expected] of [
    ['Screenshot 2026-10-02 at 15.30.12.png', 'Screenshot-2026-10-02-at-15.30.12.png'],
    ['My Photo (1).JPG', 'My-Photo-1.jpg'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\report.pdf', 'report.pdf'],
    ['.bashrc', 'bashrc'],
    ['-rf', 'rf'],
    ['$(id) `x` "q" \'s\'.txt', 'id-x-q-s.txt'],
    ['Ünïcödé.png', 'Unicode.png'],
    ['日本語.png', 'upload.png'],
    ['', 'upload'],
    [null, 'upload'],
    ['archive.tar.gz', 'archive.tar.gz'],
    ['x'.repeat(200) + '.csv', 'x'.repeat(80) + '.csv'],
  ]) assert.equal(safeName(input), expected, String(input));
});

test('an upload lands under its day, private to root, only once complete', t => {
  const { root, store } = fixture(t);
  const { upload } = store.begin('photo of the fan.jpg', 11);
  assert.equal(files(root).length, 1);
  assert.match(files(root)[0], /^2026-10-02\/153012-[0-9a-f]{6}-photo-of-the-fan\.jpg\.part$/);
  assert.deepEqual(store.chunk(upload, b64('hello ')), { received: 6 });
  assert.deepEqual(store.chunk(upload, b64('world')), { received: 11 });
  const saved = store.finish(upload);
  assert.equal(dirname(saved.path), join(root, '2026-10-02'));
  assert.match(saved.name, /^153012-[0-9a-f]{6}-photo-of-the-fan\.jpg$/);
  assert.equal(readFileSync(saved.path, 'utf8'), 'hello world');
  assert.equal(statSync(saved.path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(saved.path)).mode & 0o777, 0o700);
  assert.deepEqual(files(root), ['2026-10-02/' + saved.name]);
  assert.throws(() => store.chunk(upload, b64('more')), /Unknown upload/, 'a finished upload takes no more data');
  const empty = store.begin('empty.txt', 0);
  assert.equal(readFileSync(store.finish(empty.upload).path, 'utf8'), '');
});

test('oversized, overlong, malformed and incomplete uploads leave nothing behind', t => {
  const { root, store } = fixture(t, { maxBytes: 8 });
  assert.throws(() => store.begin('big.bin', 9), /at most/);
  for (const size of [-1, 1.5, '4', null]) assert.throws(() => store.begin('x', size), /Invalid file size/);
  const long = store.begin('long.txt', 4);
  assert.throws(() => store.chunk(long.upload, b64('12345')), /larger than announced/);
  const bad = store.begin('bad.txt', 4);
  for (const data of ['not base64!', 'QUJD\n', 'QUJ', 123]) {
    const attempt = store.begin('bad.txt', 4);
    assert.throws(() => store.chunk(attempt.upload, data), /Invalid file data/);
  }
  store.chunk(bad.upload, b64('ab'));
  assert.throws(() => store.finish(bad.upload), /incomplete/);
  const cancelled = store.begin('cancel.txt', 4);
  assert.equal(store.cancel(cancelled.upload), true);
  const dropped = store.begin('dropped.txt', 4);
  store.chunk(dropped.upload, b64('ab'));
  store.abortAll();
  assert.deepEqual(files(root), []);
  assert.throws(() => store.request({ method: 'finish', upload: '../x' }), /Unknown upload/);
  assert.throws(() => store.request({ method: 'write', path: '/etc/passwd' }), /Unknown upload operation/);
  assert.throws(() => store.request([]), /Invalid request/);
});

test('one connection holds a bounded number of uploads at a time', t => {
  const { store } = fixture(t);
  for (let i = 0; i < 8; i++) store.begin('f' + i, 1);
  assert.throws(() => store.begin('one-too-many', 1), /Too many uploads/);
});

test('pruning removes whole days older than a week and nothing else', t => {
  const { root, store } = fixture(t);
  for (const name of ['2026-09-24', '2026-09-25', '2026-10-02', 'notes']) {
    mkdirSync(join(root, name)); writeFileSync(join(root, name, 'f'), 'x');
  }
  writeFileSync(join(root, '2026-01-01'), 'a file, not a day');
  store.prune();
  assert.deepEqual(readdirSync(root).sort(), ['2026-01-01', '2026-09-25', '2026-10-02', 'notes']);
  createUploadStore({ root: join(root, 'missing') }).prune();
});

test('the stream says when it is ready, reassembles fragments, and cleans up on disconnect', async t => {
  const { root, store } = fixture(t, { maxBytes: 1024 });
  const input = new PassThrough(), output = new PassThrough();
  let data = ''; output.on('data', bytes => { data += bytes; });
  serve(store, input, output);
  const packets = () => data.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(packets()[0], { type: 'ready', maxBytes: 1024 });
  input.write('{"request":1,"method":"be');
  input.write('gin","name":"note.txt","size":5}\n{"request":2,"method":"chunk","upload":"1","data":"' + b64('hello') + '"}\n');
  input.write('{"request":3,"method":"finish","upload":"1"}\n{"request":4,"method":"begin","name":"half.txt","size":4}\n');
  input.write('{"request":5,"method":"exec","command":"id"}\nnot json\n');
  const reply = id => packets().find(p => p.request === id);
  assert.equal(readFileSync(reply(3).result.path, 'utf8'), 'hello');
  assert.match(reply(5).error, /Unknown upload operation/);
  assert.ok(packets().find(p => p.request === null).error);
  assert.equal(files(root).filter(f => f.endsWith('.part')).length, 1);
  input.end();
  await new Promise(resolve => input.once('end', resolve));
  assert.equal(files(root).filter(f => f.endsWith('.part')).length, 0, 'disconnecting discards unfinished files');
});

test('a line longer than any chunk ends the stream', t => {
  const { root, store } = fixture(t);
  const input = new PassThrough(), output = new PassThrough();
  serve(store, input, output);
  store.begin('open.txt', 4);
  input.write('{"request":1,"method":"chunk","upload":"1","data":"' + 'A'.repeat(200000));
  assert.equal(input.destroyed, true);
  assert.deepEqual(files(root), []);
});
