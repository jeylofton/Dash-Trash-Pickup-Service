/* Append-only audit trail. Never updated, never deleted. */
import { run } from '../db/index.js';

export function audit(req, action, { entityType, entityId, detail } = {}) {
  try {
    run(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, entity_id, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      req.user?.id ?? null,
      req.user?.role ?? null,
      action,
      entityType ?? null,
      entityId ?? null,
      detail ? JSON.stringify(detail) : null,
      req.ip ?? null
    );
  } catch (err) {
    // Auditing must never break the operation it is recording.
    console.error('[audit] failed to write', action, err.message);
  }
}
