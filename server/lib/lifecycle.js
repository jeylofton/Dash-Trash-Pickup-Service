/* ============================================================
   Single-action lifecycle engine.

   One rule drives the whole thing: the CURRENT status decides
   which actions exist, the admin picks exactly ONE, confirms it,
   and that one transition is recorded. Never two status changes
   in a single operation, and never a screen full of competing
   destructive buttons.

   A lifecycle spec is data, not code, so the same engine serves
   communities, routes, employees, coupons and roles:

     statuses: { key: { label, tone, description } }
     actions:  { key: { label, from, to, fields, confirm, run } }

   The SERVER is the authority. The UI asks `availableActions`
   for what to draw; `resolveAction` re-checks the very same
   rules when the action is submitted, so a hand-built request
   cannot perform a transition the UI would not have offered.
   ============================================================ */

/** A field the action needs before it can be confirmed. */
export const field = (name, label, type = 'text', extra = {}) =>
  ({ name, label, type, required: true, ...extra });

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/**
 * Which actions are valid for a record right now.
 *
 * `enabled: false` still returns the action — an admin needs to see
 * that "Activate Service" exists and WHY it is not available yet,
 * rather than wondering where the button went.
 */
export function availableActions(spec, record, ctx = {}) {
  const status = record[spec.statusField ?? 'status'];
  return Object.entries(spec.actions)
    .filter(([, a]) => a.from.includes(status))
    .filter(([, a]) => !a.visible || a.visible(record, ctx))
    .map(([key, a]) => {
      const blocked = a.blockedBy?.(record, ctx) ?? null;
      return {
        key,
        label: typeof a.label === 'function' ? a.label(record, ctx) : a.label,
        description: typeof a.description === 'function' ? a.description(record, ctx) : a.description,
        tone: a.tone ?? 'normal',
        to: a.to ?? status,
        fields: (typeof a.fields === 'function' ? a.fields(record, ctx) : a.fields) ?? [],
        enabled: !blocked,
        blockedReason: blocked,
        confirmTitle: typeof a.confirmTitle === 'function' ? a.confirmTitle(record, ctx) : a.confirmTitle,
        effects: (typeof a.effects === 'function' ? a.effects(record, ctx) : a.effects) ?? [],
        preserves: a.preserves ?? [],
      };
    });
}

/**
 * Validate a submitted action against the record's CURRENT status.
 * Throws a tagged Error (status 400/409) rather than returning a flag,
 * so a route cannot forget to check.
 */
export function resolveAction(spec, record, actionKey, input = {}, ctx = {}) {
  const status = record[spec.statusField ?? 'status'];
  const action = spec.actions[actionKey];

  if (!action) {
    throw fail(400, `"${actionKey}" is not a lifecycle action.`, 'UNKNOWN_ACTION');
  }
  if (!action.from.includes(status)) {
    throw fail(409,
      `"${action.label}" is not available while the status is "${spec.statuses[status]?.label ?? status}".`,
      'INVALID_TRANSITION', { currentStatus: status });
  }
  if (action.visible && !action.visible(record, ctx)) {
    throw fail(409, `"${action.label}" is not available for this record.`, 'INVALID_TRANSITION');
  }

  const blocked = action.blockedBy?.(record, ctx);
  if (blocked && !(action.overridable && input.force === true)) {
    throw fail(409, blocked, 'NOT_READY', { checks: ctx.readiness?.checks });
  }

  const fields = (typeof action.fields === 'function' ? action.fields(record, ctx) : action.fields) ?? [];
  const values = {};
  for (const f of fields) {
    const raw = input[f.name];
    const empty = raw === undefined || raw === null || raw === '' ||
                  (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (f.required) throw fail(400, `${f.label} is required.`, 'MISSING_FIELD', { field: f.name });
      values[f.name] = null;
      continue;
    }
    if (f.type === 'date' && !isDate(raw)) {
      throw fail(400, `${f.label} must be a date (YYYY-MM-DD).`, 'BAD_FIELD', { field: f.name });
    }
    if (f.type === 'select' && f.options && !f.options.some(o => o.value === raw)) {
      throw fail(400, `${f.label} is not one of the allowed choices.`, 'BAD_FIELD', { field: f.name });
    }
    values[f.name] = raw;
  }

  return { key: actionKey, action, values, from: status, to: action.to ?? status };
}

function fail(status, message, code, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}
