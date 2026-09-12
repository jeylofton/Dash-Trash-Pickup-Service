/* ============================================================
   Introductory-spot counter and signup log.

   Backed by a JSON file. That is fine for a single server process
   at launch volume, but see the warning on reserveIntroSpot()
   before you run more than one instance.

   To move to a real database, replace the four exported functions.
   Nothing else in the server needs to change.
   ============================================================ */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const FILE = join(DIR, 'signups.json');
const TMP = join(DIR, 'signups.tmp.json');

const EMPTY = { introClaimed: 0, signups: [] };

/* Serializes all writes within this process. Without it, two checkouts
   landing at the same moment could both read introClaimed = 99 and both
   be granted the last spot. */
let queue = Promise.resolve();
const withLock = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
};

async function read() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(EMPTY);
    throw err;
  }
}

async function write(data) {
  await mkdir(DIR, { recursive: true });
  // Write to a temp file then rename: a crash mid-write can't corrupt the
  // real file, because rename is atomic on POSIX filesystems.
  await writeFile(TMP, JSON.stringify(data, null, 2), 'utf8');
  await rename(TMP, FILE);
}

/** How many introductory spots have been used. */
export async function getIntroClaimed() {
  const data = await read();
  return data.introClaimed;
}

/**
 * Atomically take one introductory spot if any remain.
 * Returns true only if this caller got one.
 *
 * IMPORTANT: the lock above is per-process. If you deploy more than one
 * instance (or a platform that scales to several containers), move this to a
 * database and do it in one statement, e.g.
 *   UPDATE counters SET intro_claimed = intro_claimed + 1
 *   WHERE name = 'intro' AND intro_claimed < 100 RETURNING intro_claimed;
 */
export async function reserveIntroSpot(totalSpots) {
  return withLock(async () => {
    const data = await read();
    if (data.introClaimed >= totalSpots) return false;
    data.introClaimed += 1;
    await write(data);
    return true;
  });
}

/** Give a spot back when the Square call fails after we reserved it. */
export async function releaseIntroSpot() {
  return withLock(async () => {
    const data = await read();
    data.introClaimed = Math.max(0, data.introClaimed - 1);
    await write(data);
  });
}

/** Append a completed signup. Deliberately stores no card data. */
export async function recordSignup(entry) {
  return withLock(async () => {
    const data = await read();
    data.signups.push({ ...entry, createdAt: new Date().toISOString() });
    await write(data);
  });
}
