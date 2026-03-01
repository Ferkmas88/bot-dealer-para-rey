import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const sqlitePath = resolve(process.env.SQLITE_PATH || "./data/dealer.sqlite");
mkdirSync(dirname(sqlitePath), { recursive: true });

const db = new DatabaseSync(sqlitePath);
const { Pool } = pg;
const pgConnectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "";
const usePgInventory = Boolean(pgConnectionString);
const pgPool = usePgInventory
  ? new Pool({
      connectionString: pgConnectionString,
      ssl: { rejectUnauthorized: false }
    })
  : null;

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

const DEFAULT_INVENTORY = [
  {
    make: "nissan",
    model: "altima",
    year: 2005,
    price: 5000,
    mileage: 80000,
    transmission: "good",
    fuel_type: "bad",
    color: "white",
    status: "available",
    featured: 0
  },
  {
    make: "Toyota",
    model: "corolla",
    year: 2006,
    price: 5000,
    mileage: 80000,
    transmission: "buena",
    fuel_type: "bien",
    color: "rojo",
    status: "available",
    featured: 0
  }
];

function ensureDefaultInventorySeed() {
  if (usePgInventory) return;
  const count = db.prepare("SELECT COUNT(*) AS value FROM inventory").get()?.value ?? 0;
  if (count > 0) return;

  const insertSeedStmt = db.prepare(`
    INSERT INTO inventory (
      id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    DEFAULT_INVENTORY.forEach((unit, index) => {
      insertSeedStmt.run(
        index + 1,
        unit.make,
        unit.model,
        Number(unit.year),
        Number(unit.price),
        Number(unit.mileage),
        unit.transmission,
        unit.fuel_type,
        unit.color,
        unit.status,
        Number(unit.featured) ? 1 : 0,
        now,
        now
      );
    });
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

ensureDefaultInventorySeed();

async function ensurePgInventorySchemaAndSeed() {
  if (!usePgInventory || !pgPool) return;

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      mileage INTEGER NOT NULL,
      transmission TEXT NOT NULL,
      fuel_type TEXT NOT NULL,
      color TEXT NOT NULL,
      status TEXT NOT NULL,
      featured INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const result = await pgPool.query("SELECT COUNT(*)::int AS value FROM inventory");
  const count = result.rows?.[0]?.value ?? 0;
  if (count > 0) return;

  const now = new Date().toISOString();
  for (const unit of DEFAULT_INVENTORY) {
    await pgPool.query(
      `
        INSERT INTO inventory (
          make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        unit.make,
        unit.model,
        Number(unit.year),
        Number(unit.price),
        Number(unit.mileage),
        unit.transmission,
        unit.fuel_type,
        unit.color,
        unit.status,
        Number(unit.featured) ? 1 : 0,
        now,
        now
      ]
    );
  }
}

const pgInventoryReady = ensurePgInventorySchemaAndSeed().catch((error) => {
  console.error("Neon inventory init failed, using SQLite fallback:", error?.message || error);
});

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

export function listDealerConversations({ limit = 100 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 100;

  const rows = db
    .prepare(
      `
      SELECT
        m.session_id AS session_id,
        MAX(m.created_at) AS updated_at,
        SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS user_messages,
        SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages,
        (
          SELECT m2.content
          FROM messages m2
          WHERE m2.session_id = m.session_id
          ORDER BY m2.created_at DESC, m2.id DESC
          LIMIT 1
        ) AS last_message,
        (
          SELECT m2.role
          FROM messages m2
          WHERE m2.session_id = m.session_id
          ORDER BY m2.created_at DESC, m2.id DESC
          LIMIT 1
        ) AS last_role
      FROM messages m
      GROUP BY m.session_id
      ORDER BY updated_at DESC
      LIMIT ?
      `
    )
    .all(safeLimit);

  return rows;
}

export function listDealerMessagesBySession(sessionId, { limit = 500 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(2000, Number(limit))) : 500;

  const rows = db
    .prepare(
      `
      SELECT
        id,
        session_id,
        role,
        content,
        intent,
        source,
        created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
      `
    )
    .all(sessionId, safeLimit);

  return rows;
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

export async function getInventoryOverview() {
  if (usePgInventory && pgPool) {
    await pgInventoryReady;
    const totalResult = await pgPool.query("SELECT COUNT(*)::int AS value FROM inventory WHERE status = 'available'");
    const rowsResult = await pgPool.query(
      "SELECT TRIM(make) AS make, COUNT(*)::int AS count FROM inventory WHERE status = 'available' GROUP BY TRIM(make) ORDER BY count DESC, make ASC"
    );
    return {
      total: totalResult.rows?.[0]?.value ?? 0,
      byMake: (rowsResult.rows || []).map((r) => ({ make: r.make, count: r.count }))
    };
  }

  const total = db.prepare("SELECT COUNT(*) AS value FROM inventory WHERE status = 'available'").get()?.value ?? 0;
  const rows = db
    .prepare("SELECT TRIM(make) AS make, COUNT(*) AS count FROM inventory WHERE status = 'available' GROUP BY TRIM(make) ORDER BY count DESC, make ASC")
    .all();
  return { total, byMake: rows.map((r) => ({ make: r.make, count: r.count })) };
}

export async function searchAvailableInventory({ make = null, budgetMax = null, color = null, pickup = false, limit = 2 } = {}) {
  if (usePgInventory && pgPool) {
    await pgInventoryReady;
    const conditions = ["status = 'available'"];
    const params = [];
    let idx = 1;

    if (make) {
      conditions.push(`LOWER(TRIM(make)) = LOWER(TRIM($${idx++}))`);
      params.push(String(make));
    }
    if (budgetMax && Number.isFinite(Number(budgetMax))) {
      conditions.push(`price <= $${idx++}`);
      params.push(Number(budgetMax));
    }
    if (color) {
      conditions.push(`LOWER(color) = LOWER($${idx++})`);
      params.push(color);
    }
    if (pickup) {
      conditions.push(
        "(LOWER(model) LIKE '%f-150%' OR LOWER(model) LIKE '%silverado%' OR LOWER(model) LIKE '%1500%' OR LOWER(model) LIKE '%truck%' OR LOWER(make) IN ('ford', 'chevrolet', 'gmc', 'ram'))"
      );
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 2, 2));
    const query = `
      SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured
      FROM inventory
      WHERE ${conditions.join(" AND ")}
      ORDER BY featured DESC, year DESC, price ASC
      LIMIT $${idx}
    `;
    const result = await pgPool.query(query, [...params, safeLimit]);
    return result.rows || [];
  }

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

export async function searchSimilarAvailableInventory({ budgetMax = null, color = null, pickup = false, limit = 2 } = {}) {
  if (usePgInventory && pgPool) {
    await pgInventoryReady;
    const conditions = ["status = 'available'"];
    const params = [];
    let idx = 1;

    if (budgetMax && Number.isFinite(Number(budgetMax))) {
      conditions.push(`price <= $${idx++}`);
      params.push(Number(budgetMax) + 2500);
    }
    if (color) {
      conditions.push(`LOWER(color) = LOWER($${idx++})`);
      params.push(color);
    }
    if (pickup) {
      conditions.push(
        "(LOWER(model) LIKE '%f-150%' OR LOWER(model) LIKE '%silverado%' OR LOWER(model) LIKE '%1500%' OR LOWER(model) LIKE '%truck%' OR LOWER(make) IN ('ford', 'chevrolet', 'gmc', 'ram'))"
      );
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 2, 2));
    const query = `
      SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured
      FROM inventory
      WHERE ${conditions.join(" AND ")}
      ORDER BY featured DESC, year DESC, price ASC
      LIMIT $${idx}
    `;
    const result = await pgPool.query(query, [...params, safeLimit]);
    return result.rows || [];
  }

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

export async function getMinAvailablePriceByMake(make) {
  if (!make) return null;
  if (usePgInventory && pgPool) {
    await pgInventoryReady;
    const result = await pgPool.query(
      "SELECT MIN(price) AS min_price FROM inventory WHERE status = 'available' AND LOWER(TRIM(make)) = LOWER(TRIM($1))",
      [String(make)]
    );
    const value = result.rows?.[0]?.min_price;
    return value == null ? null : Number(value);
  }

  const row = db
    .prepare("SELECT MIN(price) AS min_price FROM inventory WHERE status = 'available' AND LOWER(TRIM(make)) = LOWER(TRIM(?))")
    .get(String(make));
  if (!row || row.min_price == null) return null;
  return Number(row.min_price);
}

export async function listInventory({ status = null } = {}) {
  if (usePgInventory && pgPool) {
    await pgInventoryReady;
    const hasStatus = typeof status === "string" && status.trim().length > 0;
    if (hasStatus) {
      const result = await pgPool.query(
        `
          SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
          FROM inventory
          WHERE LOWER(status) = LOWER($1)
          ORDER BY updated_at DESC, id DESC
        `,
        [status]
      );
      return result.rows || [];
    }
    const result = await pgPool.query(`
      SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
      FROM inventory
      ORDER BY updated_at DESC, id DESC
    `);
    return result.rows || [];
  }

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

export async function getInventoryById(id) {
  if (usePgInventory && pgPool) {
    await pgInventoryReady;
    const result = await pgPool.query(
      `
      SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
      FROM inventory
      WHERE id = $1
      `,
      [Number(id)]
    );
    return result.rows?.[0] || null;
  }

  return (
    db
      .prepare(
        "SELECT id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at FROM inventory WHERE id = ?"
      )
      .get(Number(id)) || null
  );
}

export async function createInventoryUnit(input) {
  if (usePgInventory && pgPool) {
    await pgInventoryReady;
    const now = new Date().toISOString();
    const result = await pgPool.query(
      `
      INSERT INTO inventory (
        make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
    `,
      [
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
      ]
    );
    return result.rows?.[0] || null;
  }

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

export async function updateInventoryUnit(id, input) {
  const existing = await getInventoryById(id);
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

  if (usePgInventory && pgPool) {
    await pgInventoryReady;
    const result = await pgPool.query(
      `
      UPDATE inventory
      SET make = $1, model = $2, year = $3, price = $4, mileage = $5, transmission = $6, fuel_type = $7, color = $8, status = $9, featured = $10, updated_at = $11
      WHERE id = $12
      RETURNING id, make, model, year, price, mileage, transmission, fuel_type, color, status, featured, created_at, updated_at
      `,
      [
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
      ]
    );
    return result.rows?.[0] || null;
  }

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

export async function deleteInventoryUnit(id) {
  const existing = await getInventoryById(id);
  if (!existing) return false;

  if (usePgInventory && pgPool) {
    await pgInventoryReady;
    await pgPool.query("DELETE FROM inventory WHERE id = $1", [Number(id)]);
    return true;
  }

  db.prepare("DELETE FROM inventory WHERE id = ?").run(Number(id));
  return true;
}
