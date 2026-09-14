/* ============================================================
   What can happen to a subscription plan, and what each does.
   Draft while being built; Active while selectable; Inactive when
   it stops taking NEW subscriptions (existing history stays); Archived
   when filed away. Nothing here deletes subscription history.
   ============================================================ */

import { run } from '../db/index.js';
import { field } from './lifecycle.js';

export const PLAN_STATUSES = {
  draft:    { label: 'Draft',    tone: 'muted',
              description: 'Still being configured. Customers cannot see it.' },
  active:   { label: 'Active',   tone: 'ok',
              description: 'Available for use. May be offered to customers when made available.' },
  inactive: { label: 'Inactive', tone: 'warn',
              description: 'Not accepting new subscriptions. Existing customer history stays.' },
  archived: { label: 'Archived', tone: 'muted',
              description: 'Out of normal management views. Preserved historically.' },
};

const noteField = () => [field('notes', 'Notes', 'textarea', { required: false })];

export const PLAN_LIFECYCLE = {
  entity: 'plan',
  statusField: 'status',
  statuses: PLAN_STATUSES,
  actions: {
    activate: {
      label: 'Activate Plan', tone: 'primary',
      from: ['draft', 'inactive'], to: 'active',
      fields: noteField,
      confirmTitle: (p) => `Activate ${p.name}?`,
      effects: ['The plan becomes usable. Make it customer-available to offer it at signup.'],
      run(p) {
        run(`UPDATE plans SET status='active', archived_at=NULL, updated_at=datetime('now') WHERE id=?`, p.id);
        return { message: `${p.name} is active.` };
      },
    },
    deactivate: {
      label: 'Deactivate Plan', tone: 'warn',
      from: ['active'], to: 'inactive',
      fields: noteField,
      confirmTitle: (p) => `Deactivate ${p.name}?`,
      effects: ['No NEW subscriptions can be created on it.',
                'Existing subscribers and all history are untouched.'],
      run(p) {
        run(`UPDATE plans SET status='inactive', customer_available=0, updated_at=datetime('now') WHERE id=?`, p.id);
        return { message: `${p.name} no longer accepts new subscriptions.` };
      },
    },
    archive: {
      label: 'Archive Plan', tone: 'danger',
      from: ['draft', 'active', 'inactive'], to: 'archived',
      fields: noteField,
      confirmTitle: (p) => `Archive ${p.name}?`,
      effects: ['It leaves active management views.',
                'Every subscription and coupon link to it is preserved.'],
      run(p) {
        run(`UPDATE plans SET status='archived', customer_available=0,
                archived_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, p.id);
        return { message: `${p.name} archived. History is intact.` };
      },
    },
    restore: {
      label: 'Restore Plan', tone: 'primary',
      from: ['archived'], to: 'inactive',
      fields: noteField,
      confirmTitle: (p) => `Restore ${p.name} from the archive?`,
      effects: ['It returns as Inactive. Activate it to offer it again.'],
      run(p) {
        run(`UPDATE plans SET status='inactive', archived_at=NULL, updated_at=datetime('now') WHERE id=?`, p.id);
        return { message: `${p.name} restored as inactive.` };
      },
    },
  },
};
