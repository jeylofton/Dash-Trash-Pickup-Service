/* ============================================================
   Photo storage adapter.

   Images never go in the database - only a storage key does.
   Local disk today; fill in the S3 branch to move to S3, R2, or
   any S3-compatible bucket without touching upload code.

   Files are written OUTSIDE the web root and streamed back only
   through an authorized route, so a photo URL cannot be guessed
   or shared to bypass permissions.
   ============================================================ */

import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(HERE, '..', 'data', 'uploads');

const DRIVER = process.env.STORAGE_DRIVER || 'local';

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png',  '.png'],
  ['image/webp', '.webp'],
  ['image/heic', '.heic'],
]);
export const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024);

export function uploadProblem({ mimeType, bytes }) {
  if (!ALLOWED.has(mimeType)) return 'Photos must be JPEG, PNG, WEBP, or HEIC.';
  if (bytes > MAX_BYTES) return `Photos must be under ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`;
  return null;
}

/* ---------- local driver ---------- */

const local = {
  async put(buffer, { mimeType }) {
    const ext = ALLOWED.get(mimeType) || '.bin';
    // Shard by date so one directory never holds a million files.
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}/${randomUUID()}${ext}`;
    const full = join(UPLOAD_DIR, key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return key;
  },
  async get(key) {
    return readFile(safePath(key));
  },
  async remove(key) {
    await unlink(safePath(key)).catch(() => {});
  },
};

/** Refuse keys containing traversal, so "../../etc/passwd" cannot escape. */
function safePath(key) {
  const full = join(UPLOAD_DIR, key);
  if (!full.startsWith(UPLOAD_DIR)) throw new Error('Invalid storage key');
  return full;
}

/* ---------- s3 driver (fill in to switch) ---------- */

const s3 = {
  async put() {
    throw new Error(
      'S3 driver not implemented. Install @aws-sdk/client-s3, then implement ' +
      'put/get/remove here and set STORAGE_DRIVER=s3.'
    );
  },
  async get() { throw new Error('S3 driver not implemented.'); },
  async remove() { throw new Error('S3 driver not implemented.'); },
};

const drivers = { local, s3 };
const driver = drivers[DRIVER] || local;

export const storage = {
  driver: DRIVER,
  put: (buffer, meta) => driver.put(buffer, meta),
  get: (key) => driver.get(key),
  remove: (key) => driver.remove(key),
  contentTypeFor: (key) => {
    const ext = extname(key);
    for (const [mime, e] of ALLOWED) if (e === ext) return mime;
    return 'application/octet-stream';
  },
};
