/* ============================================================
   Community service lifecycle.

   A community's status is an OPERATIONAL state, not a record
   state: putting service on hold, cancelling it, or archiving a
   property must never rewrite what already happened there. So
   everything this migration adds is forward-looking — an
   effective date, a reason, and enough memory to put service
   back the way it was.

   Every step is guarded, so running it repeatedly is safe.
   ============================================================ */

import { db, one, all } from './index.js';

const columns = (table) => all(`PRAGMA table_info(${table})`).map(c => c.name);

function addColumn(table, name, definition) {
  if (columns(table).includes(name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  return true;
}

export function migrateCommunityLifecycle() {
  const changes = [];

  /* --- communities: when a lifecycle change takes effect and why --- */
  const add = (name, def, label) => { if (addColumn('communities', name, def)) changes.push(label); };

  add('hold_effective_date',      'TEXT', 'communities.hold_effective_date');
  add('hold_reason',              'TEXT', 'communities.hold_reason');
  // The pickup days that were running when service was put on hold, so
  // Resume can restore exactly the schedule that was paused.
  add('held_days',                'TEXT', 'communities.held_days');
  add('cancelled_effective_date', 'TEXT', 'communities.cancelled_effective_date');
  add('cancellation_reason',      'TEXT', 'communities.cancellation_reason');
  add('cancellation_note',        'TEXT', 'communities.cancellation_note');

  /* --- status history: the effective date and reason behind each change --- */
  if (addColumn('community_status_history', 'effective_date', 'TEXT'))
    changes.push('community_status_history.effective_date');
  if (addColumn('community_status_history', 'reason', 'TEXT'))
    changes.push('community_status_history.reason');
  // Which lifecycle action produced the change ('hold', 'cancel', ...).
  if (addColumn('community_status_history', 'action', 'TEXT'))
    changes.push('community_status_history.action');

  /* --- one word for one concept: 'paused' was the old name for 'on_hold' --- */
  const paused = one(`SELECT COUNT(*) n FROM communities WHERE status = 'paused'`)?.n ?? 0;
  if (paused) {
    db.exec(`UPDATE communities SET status = 'on_hold' WHERE status = 'paused'`);
    changes.push(`${paused} community/communities moved from 'paused' to 'on_hold'`);
  }

  /* --- pickup_schedules is effective-dated; make sure old rows have a start --- */
  if (columns('pickup_schedules').includes('effective_date')) {
    db.exec(`UPDATE pickup_schedules SET effective_date = '2000-01-01'
              WHERE effective_date IS NULL OR effective_date = ''`);
  }

  return changes;
}
