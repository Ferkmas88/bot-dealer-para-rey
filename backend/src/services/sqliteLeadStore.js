import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const sqlitePath = resolve(process.env.SQLITE_PATH || "./data/dealer.sqlite");
mkdirSync(dirname(sqlitePath), { recursive: true });

const db = new DatabaseSync(sqlitePath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS leads (
    session_id TEXT PRIMARY KEY,
    model TEXT,
    budget REAL,
    date_pref TEXT,
    email TEXT,
    phone TEXT,
    last_intent TEXT,
    last_source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    intent TEXT,
    source TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages(session_id, created_at);

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT,
    reply TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    year INTEGER NOT NULL,
    price REAL NOT NULL,
    mileage INTEGER NOT NULL,
    transmission TEXT NOT NULL,
    fuel_type TEXT NOT NULL,
    color TEXT NOT NULL,
    status TEXT NOT NULL,
    featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const upsertLeadStmt = db.prepare(`
  INSERT INTO leads (
    session_id, model, budget, date_pref, email, phone, last_intent, last_source, created_at, updated_at
  )
  VALUES (
    @session_id, @model, @budget, @date_pref, @email, @phone, @last_intent, @last_source, @created_at, @updated_at
  )
  ON CONFLICT(session_id) DO UPDATE SET
    model = excluded.model,
    budget = excluded.budget,
    date_pref = excluded.date_pref,
    email = excluded.email,
    phone = excluded.phone,
    last_intent = excluded.last_intent,
    last_source = excluded.last_source,
    updated_at = excluded.updated_at
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (session_id, role, content, intent, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertFeedbackStmt = db.prepare(`
  INSERT INTO feedback (session_id, rating, comment, reply, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

export function persistDealerTurnToSqlite({ sessionId, userMessage, aiResult, timestamp }) {
  const entities = aiResult?.entities || {};
  const contact = entities.contact || {};

  try {
    db.exec("BEGIN");

    upsertLeadStmt.run({
      session_id: sessionId,
      model: entities.model ?? null,
      budget: entities.budget ?? null,
      date_pref: entities.date ?? null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      last_intent: aiResult?.intent ?? null,
      last_source: aiResult?.source ?? "fallback",
      created_at: timestamp,
      updated_at: timestamp
    });

    insertMessageStmt.run(
      sessionId,
      "user",
      userMessage || "",
      aiResult?.intent ?? null,
      aiResult?.source ?? "fallback",
      timestamp
    );

    insertMessageStmt.run(
      sessionId,
      "assistant",
      aiResult?.reply || "",
      aiResult?.intent ?? null,
      aiResult?.source ?? "fallback",
      timestamp
    );

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // noop
    }
    throw error;
  }
}

export function persistDealerFeedbackToSqlite({ sessionId, rating, comment = "", reply = "" }) {
  insertFeedbackStmt.run(sessionId, rating, comment, reply, new Date().toISOString());
}

export function getSqliteHealth() {
  try {
    db.prepare("SELECT 1").get();
    const counts = {
      leads: db.prepare("SELECT COUNT(*) AS value FROM leads").get()?.value ?? 0,
      messages: db.prepare("SELECT COUNT(*) AS value FROM messages").get()?.value ?? 0,
      feedback: db.prepare("SELECT COUNT(*) AS value FROM feedback").get()?.value ?? 0
    };
    const latestLead = db
      .prepare("SELECT session_id, model, last_intent, last_source, updated_at FROM leads ORDER BY updated_at DESC LIMIT 1")
      .get();
    return { ok: true, path: sqlitePath, counts, latestLead: latestLead || null };
  } catch (error) {
    return { ok: false, path: sqlitePath, reason: error?.message || "sqlite check failed" };
  }
}

export function getInventoryOverview() {
  const total = db.prepare("SELECT COUNT(*) AS value FROM inventory WHERE status = 'available'").get()?.value ?? 0;
  const rows = db
    .prepare("SELECT TRIM(make) AS make, COUNT(*) AS count FROM inventory WHERE status = 'available' GROUP BY TRIM(make) ORDER BY count DESC, make ASC")
    .all();

  return {
    total,
    byMake: rows.map((r) => ({ make: r.make, count: r.count }))
  };
}

export function searchAvailableInventory({ make = null, budgetMax = null, color = null, pickup = false, limit = 2 } = {}) {
  const conditions = ["status = 'available'"];
  const params = [];

  if (make) {
    conditions.push("LOWER(TRIM(make)) = LOWER(TRIM(?))");
    params.push(String(make));
  }

  if (budgetMax && Number.isFinite(Number(budgetMax))) {
    conditions.push("price <= ?");
    params.push(Number(budgetMax));
  }

  if (color) {
    conditions.push("LOWER(color) = LOWER(?)");
    params.push(color);
  }

  if (pickup) {
    conditions.push(
      "(LOWER(model) LIKE '%f-150%' OR LOWER(model) LIKE '%silverado%' OR LOWER(model) LIKE '%1500%' OR LOWER(model) LIKE '%truck%' OR LOWER(make) IN ('ford', 'chevrolet', 'gmc', 'ram'))"
    );
  }

  params.push(Math.max(1, Math.min(Number(limit) || 2, 2)));

  const sql = `
    SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured
    FROM inventory
    WHERE ${conditions.join(" AND ")}
    ORDER BY featured DESC, year DESC, price ASC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params);
}

export function searchSimilarAvailableInventory({ budgetMax = null, color = null, pickup = false, limit = 2 } = {}) {
  const conditions = ["status = 'available'"];
  const params = [];

  if (budgetMax && Number.isFinite(Number(budgetMax))) {
    conditions.push("price <= ?");
    params.push(Number(budgetMax) + 2500);
  }

  if (color) {
    conditions.push("LOWER(color) = LOWER(?)");
    params.push(color);
  }

  if (pickup) {
    conditions.push(
      "(LOWER(model) LIKE '%f-150%' OR LOWER(model) LIKE '%silverado%' OR LOWER(model) LIKE '%1500%' OR LOWER(model) LIKE '%truck%' OR LOWER(make) IN ('ford', 'chevrolet', 'gmc', 'ram'))"
    );
  }

  params.push(Math.max(1, Math.min(Number(limit) || 2, 2)));

  const sql = `
    SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured
    FROM inventory
    WHERE ${conditions.join(" AND ")}
    ORDER BY featured DESC, year DESC, price ASC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params);
}

export function getMinAvailablePriceByMake(make) {
  if (!make) return null;
  const row = db
    .prepare("SELECT MIN(price) AS min_price FROM inventory WHERE status = 'available' AND LOWER(TRIM(make)) = LOWER(TRIM(?))")
    .get(String(make));
  if (!row || row.min_price == null) return null;
  return Number(row.min_price);
}

export function listInventory({ status = null } = {}) {
  const hasStatus = typeof status === "string" && status.trim().length > 0;
  const sql = hasStatus
    ? `
      SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
      FROM inventory
      WHERE LOWER(status) = LOWER(?)
      ORDER BY updated_at DESC, id DESC
    `
    : `
      SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
      FROM inventory
      ORDER BY updated_at DESC, id DESC
    `;

  return hasStatus ? db.prepare(sql).all(status) : db.prepare(sql).all();
}

export function getInventoryById(id) {
  return (
    db
      .prepare(
        "SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at FROM inventory WHERE id = ?"
      )
      .get(Number(id)) || null
  );
}

export function createInventoryUnit(input) {
  const now = new Date().toISOString();
  const nextIdRow = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM inventory").get();
  const nextId = Number(nextIdRow?.next_id || 1);

  db.prepare(
    `
      INSERT INTO inventory (
        id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    nextId,
    String(input.make || "").trim(),
    String(input.model || "").trim(),
    Number(input.year),
    Number(input.price),
    Number(input.mileage),
    String(input.transmission || "").trim(),
    String(input.fuel_type || "").trim(),
    String(input.color || "").trim(),
    String(input.status || "available").trim(),
    Number(input.featured) ? 1 : 0,
    now,
    now
  );

  return getInventoryById(nextId);
}

export function updateInventoryUnit(id, input) {
  const existing = getInventoryById(id);
  if (!existing) return null;

  const next = {
    make: input.make != null ? String(input.make).trim() : existing.make,
    model: input.model != null ? String(input.model).trim() : existing.model,
    year: input.year ?? existing.year,
    price: input.price ?? existing.price,
    mileage: input.mileage ?? existing.mileage,
    transmission: input.transmission != null ? String(input.transmission).trim() : existing.transmission,
    fuel_type: input.fuel_type != null ? String(input.fuel_type).trim() : existing.fuel_type,
    color: input.color != null ? String(input.color).trim() : existing.color,
    status: input.status != null ? String(input.status).trim() : existing.status,
    featured: input.featured ?? existing.featured
  };

  db.prepare(
    `
      UPDATE inventory
      SET make = ?, model = ?, year = ?, price = ?, mileage = ?, transmission = ?, fuel_type = ?, color = ?, status = ?, featured = ?, updated_at = ?
      WHERE id = ?
    `
  ).run(
    next.make,
    next.model,
    Number(next.year),
    Number(next.price),
    Number(next.mileage),
    next.transmission,
    next.fuel_type,
    next.color,
    next.status,
    Number(next.featured) ? 1 : 0,
    new Date().toISOString(),
    Number(id)
  );

  return getInventoryById(id);
}

export function deleteInventoryUnit(id) {
  const existing = getInventoryById(id);
  if (!existing) return false;

  db.prepare("DELETE FROM inventory WHERE id = ?").run(Number(id));
  return true;
}
