import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const daysArg = Number(process.argv[2] || 7);
const days = Number.isFinite(daysArg) && daysArg > 0 ? daysArg : 7;
const sqlitePath = resolve(process.env.SQLITE_PATH || "./data/dealer.sqlite");
const db = new DatabaseSync(sqlitePath);

const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

let rows = [];
try {
  rows = db
    .prepare(
      `
    WITH first_variant AS (
      SELECT
        ce.session_id,
        ce.copy_variant,
        MIN(ce.created_at) AS first_event_at
      FROM conversation_events ce
      WHERE ce.created_at >= ?
        AND ce.copy_variant IN ('A', 'B')
      GROUP BY ce.session_id, ce.copy_variant
    ),
    canonical AS (
      SELECT fv.session_id, fv.copy_variant, fv.first_event_at
      FROM first_variant fv
      JOIN (
        SELECT session_id, MIN(first_event_at) AS min_first
        FROM first_variant
        GROUP BY session_id
      ) pick
        ON pick.session_id = fv.session_id
       AND pick.min_first = fv.first_event_at
    ),
    appt AS (
      SELECT DISTINCT a.lead_session_id AS session_id
      FROM appointments a
      WHERE a.created_at >= ?
    )
    SELECT
      c.copy_variant AS variant,
      COUNT(*) AS conversations_started,
      SUM(CASE WHEN a.session_id IS NOT NULL THEN 1 ELSE 0 END) AS appointments_created
    FROM canonical c
    LEFT JOIN appt a ON a.session_id = c.session_id
    GROUP BY c.copy_variant
    ORDER BY c.copy_variant
  `
    )
    .all(sinceIso, sinceIso);
} catch (error) {
  if (!/no such table/i.test(String(error?.message || ""))) {
    throw error;
  }
}

const normalized = ["A", "B"].map((variant) => {
  const row = rows.find((r) => String(r.variant) === variant) || {};
  const conversationsStarted = Number(row.conversations_started || 0);
  const appointmentsCreated = Number(row.appointments_created || 0);
  const rate = conversationsStarted > 0 ? (appointmentsCreated / conversationsStarted) * 100 : 0;
  return {
    variant,
    conversationsStarted,
    appointmentsCreated,
    appointmentCreatedRatePct: Number(rate.toFixed(2))
  };
});

console.log(JSON.stringify({ windowDays: days, sinceIso, variants: normalized }, null, 2));
