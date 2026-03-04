import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";

function resolveSqlitePath() {
  if (process.env.SQLITE_PATH) return resolve(process.env.SQLITE_PATH);
  const cwdData = resolve("./data/dealer.sqlite");
  const parentData = resolve("../data/dealer.sqlite");
  const candidates = [cwdData, parentData].filter((p) => existsSync(p));
  if (!candidates.length) return cwdData;
  if (candidates.length === 1) return candidates[0];
  const withSize = candidates.map((p) => ({ p, size: Number(statSync(p).size || 0) }));
  withSize.sort((a, b) => b.size - a.size);
  return withSize[0].p;
}

const sqlitePath = resolveSqlitePath();
const db = new DatabaseSync(sqlitePath);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some((c) => String(c?.name || "").toLowerCase() === String(column).toLowerCase());
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function runRepair() {
  const startedAt = new Date().toISOString();
  const stats = {
    startedAt,
    sqlitePath,
    deletedDuplicateMessages: 0,
    normalizedLeadPhones: 0,
    normalizedLeadNames: 0,
    appointmentStatusUpdates: 0
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      session_id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      last_message_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT,
      direction TEXT,
      content TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_session_id TEXT,
      scheduled_at TEXT,
      status TEXT,
      updated_at TEXT
    );
  `);

  db.exec("BEGIN");
  try {
    ensureColumn("messages", "direction", "TEXT");
    ensureColumn("leads", "name", "TEXT");
    ensureColumn("leads", "phone", "TEXT");
    ensureColumn("leads", "last_message_at", "TEXT");
    ensureColumn("leads", "updated_at", "TEXT");

    // Keep latest row for duplicate message payloads.
    const beforeDup = Number(
      db.prepare("SELECT COUNT(1) AS value FROM messages").get()?.value || 0
    );
    db.exec(`
      DELETE FROM messages
      WHERE id IN (
        SELECT m1.id
        FROM messages m1
        JOIN messages m2
          ON m1.session_id = m2.session_id
         AND COALESCE(m1.role, '') = COALESCE(m2.role, '')
         AND COALESCE(m1.direction, '') = COALESCE(m2.direction, '')
         AND COALESCE(m1.content, '') = COALESCE(m2.content, '')
         AND COALESCE(m1.created_at, '') = COALESCE(m2.created_at, '')
         AND m1.id < m2.id
      );
    `);
    const afterDup = Number(
      db.prepare("SELECT COUNT(1) AS value FROM messages").get()?.value || 0
    );
    stats.deletedDuplicateMessages = Math.max(0, beforeDup - afterDup);

    // Normalize lead phone and obvious prefixed names.
    const leads = db
      .prepare("SELECT session_id, name, phone FROM leads")
      .all();
    const updateLead = db.prepare(
      "UPDATE leads SET name = ?, phone = ?, updated_at = ? WHERE session_id = ?"
    );
    const now = new Date().toISOString();
    for (const lead of leads) {
      const prevName = String(lead.name || "").trim();
      const prevPhone = lead.phone;
      const nextName = prevName
        .replace(/^(soy|i am)\s+/i, "")
        .replace(/^(me llamo|mi nombre es|my name is)\s+/i, "")
        .trim();
      const nextPhone = normalizePhone(prevPhone);
      if (nextName !== prevName || nextPhone !== prevPhone) {
        updateLead.run(nextName || null, nextPhone, now, lead.session_id);
        if (nextName !== prevName) stats.normalizedLeadNames += 1;
        if (nextPhone !== prevPhone) stats.normalizedLeadPhones += 1;
      }
    }

    // Move very old pending appointments to no_show to reduce noise.
    const apptResult = db.prepare(`
      UPDATE appointments
      SET status = 'NO_SHOW', updated_at = ?
      WHERE status IN ('PENDING', 'RESCHEDULED')
        AND datetime(scheduled_at) < datetime('now', '-1 day')
    `).run(now);
    stats.appointmentStatusUpdates = Number(apptResult.changes || 0);

    // Refresh lead last_message_at from latest message.
    db.exec(`
      UPDATE leads
      SET last_message_at = (
        SELECT MAX(m.created_at)
        FROM messages m
        WHERE m.session_id = leads.session_id
      ),
      updated_at = CASE
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.session_id = leads.session_id)
        THEN '${now}'
        ELSE updated_at
      END
      WHERE session_id IN (SELECT DISTINCT session_id FROM messages);
    `);

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // noop
    }
    throw error;
  }

  // Maintenance outside transaction.
  db.exec("ANALYZE;");
  db.exec("VACUUM;");

  const finishedAt = new Date().toISOString();
  return { ...stats, finishedAt };
}

try {
  const report = runRepair();
  console.log(JSON.stringify({ ok: true, report }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
}
