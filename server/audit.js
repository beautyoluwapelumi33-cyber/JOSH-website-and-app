'use strict';

const crypto = require('crypto');
const db = require('./db');

/**
 * Append-only audit trail for privileged and financial actions.
 * Never store secrets here: metadata is JSON about *what changed*, not credentials.
 */
function audit({ actorId = null, action, target = null, metadata = null }) {
  db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      actorId,
      String(action),
      target == null ? null : String(target),
      metadata == null ? null : JSON.stringify(metadata),
      new Date().toISOString(),
    ]
  );
}

function recent(limit = 50) {
  return db.all(
    `SELECT a.id, a.actor_id, u.email AS actor_email, a.action, a.target, a.metadata, a.created_at
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT ?`,
    [Math.min(Number(limit) || 50, 200)]
  );
}

module.exports = { audit, recent };
