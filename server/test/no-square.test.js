import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'docs', 'images', 'test']);

function* files(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|html|css|sql|json|example)$/.test(e)) yield p;
  }
}

test('no source file mentions Square', () => {
  const hits = [];
  for (const f of files(ROOT)) {
    if (/square/i.test(readFileSync(f, 'utf8'))) hits.push(f.replace(ROOT, ''));
  }
  assert.deepEqual(hits, [], `Square references remain in:\n${hits.join('\n')}`);
});

test('the app boots with no payment credentials set', async () => {
  for (const k of Object.keys(process.env)) if (/^SQUARE_/.test(k)) delete process.env[k];
  process.env.DB_PATH = ':memory:';
  const { payments, providerName } = await import('../lib/payments/index.js');
  assert.equal(providerName, 'demo');
  assert.equal(typeof payments.charge, 'function');
});
