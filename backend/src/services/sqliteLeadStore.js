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
    name TEXT,
    source TEXT,
    language TEXT,
    intent TEXT,
    status TEXT DEFAULT 'NEW',
    assigned_to TEXT,
    priority TEXT DEFAULT 'NORMAL',
    mode TEXT DEFAULT 'BOT',
    model TEXT,
    budget REAL,
    date_pref TEXT,
    email TEXT,
    phone TEXT,
    last_intent TEXT,
    last_source TEXT,
    last_message_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    direction TEXT,
    content TEXT NOT NULL,
    intent TEXT,
    source TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_session_role_created
  ON messages(session_id, role, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_session_id
  ON messages(session_id, id DESC);

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

  CREATE TABLE IF NOT EXISTS conversation_settings (
    session_id TEXT PRIMARY KEY,
    bot_enabled INTEGER NOT NULL DEFAULT 1,
    last_read_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_session_id TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    vehicle_id INTEGER,
    status TEXT NOT NULL DEFAULT 'PENDING',
    confirmation_state TEXT NOT NULL DEFAULT 'PROPOSED',
    proposal_options TEXT,
    notes TEXT,
    reminder_2h_sent_at TEXT,
    reminder_15m_sent_at TEXT,
    confirmed_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (lead_session_id) REFERENCES leads(session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_appointments_scheduled_at
  ON appointments(scheduled_at);

  CREATE INDEX IF NOT EXISTS idx_appointments_lead
  ON appointments(lead_session_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_appointments_lead_status_scheduled
  ON appointments(lead_session_id, status, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_leads_last_message_at
  ON leads(last_message_at);
  CREATE INDEX IF NOT EXISTS idx_leads_phone
  ON leads(phone);

  CREATE TABLE IF NOT EXISTS processed_messages (
    message_key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    channel TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_processed_messages_created_at
  ON processed_messages(created_at);

  CREATE TABLE IF NOT EXISTS conversation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    channel TEXT,
    user_id TEXT,
    copy_variant TEXT,
    action TEXT,
    intent TEXT,
    active_flow TEXT,
    missing_fields TEXT,
    latency_ms INTEGER,
    error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_events_session_created
  ON conversation_events(session_id, created_at);
`);

function ensureSqliteColumn(tableName, columnName, definition) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = cols.some((col) => String(col.name || "").toLowerCase() === String(columnName).toLowerCase());
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function ensureSqliteSchemaEvolution() {
  ensureSqliteColumn("leads", "name", "TEXT");
  ensureSqliteColumn("leads", "source", "TEXT");
  ensureSqliteColumn("leads", "language", "TEXT");
  ensureSqliteColumn("leads", "intent", "TEXT");
  ensureSqliteColumn("leads", "status", "TEXT DEFAULT 'NEW'");
  ensureSqliteColumn("leads", "assigned_to", "TEXT");
  ensureSqliteColumn("leads", "priority", "TEXT DEFAULT 'NORMAL'");
  ensureSqliteColumn("leads", "mode", "TEXT DEFAULT 'BOT'");
  ensureSqliteColumn("leads", "last_message_at", "TEXT");
  ensureSqliteColumn("messages", "direction", "TEXT");
  ensureSqliteColumn("conversation_events", "copy_variant", "TEXT");
}

ensureSqliteSchemaEvolution();

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

async function ensurePgMessagingSchema() {
  if (!usePgInventory || !pgPool) return;

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      session_id TEXT PRIMARY KEY,
      name TEXT,
      source TEXT,
      language TEXT,
      intent TEXT,
      status TEXT DEFAULT 'NEW',
      assigned_to TEXT,
      priority TEXT DEFAULT 'NORMAL',
      mode TEXT DEFAULT 'BOT',
      model TEXT,
      budget DOUBLE PRECISION,
      date_pref TEXT,
      email TEXT,
      phone TEXT,
      last_intent TEXT,
      last_source TEXT,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      direction TEXT,
      content TEXT NOT NULL,
      intent TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_created
    ON messages(session_id, created_at);
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_role_created
    ON messages(session_id, role, created_at DESC);
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_id
    ON messages(session_id, id DESC);
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      reply TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS conversation_settings (
      session_id TEXT PRIMARY KEY,
      bot_enabled INTEGER NOT NULL DEFAULT 1,
      last_read_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id BIGSERIAL PRIMARY KEY,
      lead_session_id TEXT NOT NULL REFERENCES leads(session_id),
      scheduled_at TIMESTAMPTZ NOT NULL,
      vehicle_id BIGINT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      confirmation_state TEXT NOT NULL DEFAULT 'PROPOSED',
      proposal_options JSONB,
      notes TEXT,
      reminder_2h_sent_at TIMESTAMPTZ,
      reminder_15m_sent_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      channel TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS conversation_events (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      channel TEXT,
      user_id TEXT,
      copy_variant TEXT,
      action TEXT,
      intent TEXT,
      active_flow TEXT,
      missing_fields TEXT,
      latency_ms INTEGER,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS name TEXT`);
  await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT`);
  await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS language TEXT`);
  await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS intent TEXT`);
  await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'NEW'`);
  await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to TEXT`);
  await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'NORMAL'`);
  await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'BOT'`);
  await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ`);
  await pgPool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS direction TEXT`);

  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_appointments_scheduled_at
    ON appointments(scheduled_at)
  `);

  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_appointments_lead
    ON appointments(lead_session_id, updated_at)
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_appointments_lead_status_scheduled
    ON appointments(lead_session_id, status, scheduled_at DESC)
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_leads_last_message_at
    ON leads(last_message_at DESC)
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_leads_phone
    ON leads(phone)
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_processed_messages_created_at
    ON processed_messages(created_at DESC)
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_conversation_events_session_created
    ON conversation_events(session_id, created_at DESC)
  `);
}

const pgMessagingReady = ensurePgMessagingSchema().catch((error) => {
  console.error("Neon messaging init failed, using SQLite fallback:", error?.message || error);
});

const upsertLeadStmt = db.prepare(`
  INSERT INTO leads (
    session_id, name, source, language, intent, status, assigned_to, priority, mode, model, budget, date_pref, email, phone, last_intent, last_source, last_message_at, created_at, updated_at
  )
  VALUES (
    @session_id, @name, @source, @language, @intent, @status, @assigned_to, @priority, @mode, @model, @budget, @date_pref, @email, @phone, @last_intent, @last_source, @last_message_at, @created_at, @updated_at
  )
  ON CONFLICT(session_id) DO UPDATE SET
    name = excluded.name,
    source = excluded.source,
    language = excluded.language,
    intent = excluded.intent,
    status = excluded.status,
    assigned_to = excluded.assigned_to,
    priority = excluded.priority,
    mode = excluded.mode,
    model = excluded.model,
    budget = excluded.budget,
    date_pref = excluded.date_pref,
    email = excluded.email,
    phone = excluded.phone,
    last_intent = excluded.last_intent,
    last_source = excluded.last_source,
    last_message_at = excluded.last_message_at,
    updated_at = excluded.updated_at
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (session_id, role, direction, content, intent, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertFeedbackStmt = db.prepare(`
  INSERT INTO feedback (session_id, rating, comment, reply, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

const upsertConversationSettingsStmt = db.prepare(`
  INSERT INTO conversation_settings (session_id, bot_enabled, last_read_at, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    bot_enabled = excluded.bot_enabled,
    last_read_at = excluded.last_read_at,
    updated_at = excluded.updated_at
`);

const markConversationReadStmt = db.prepare(`
  INSERT INTO conversation_settings (session_id, bot_enabled, last_read_at, updated_at)
  VALUES (?, 1, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    last_read_at = excluded.last_read_at,
    updated_at = excluded.updated_at
`);

const upsertPushSubscriptionStmt = db.prepare(`
  INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(endpoint) DO UPDATE SET
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    user_agent = excluded.user_agent,
    updated_at = excluded.updated_at
`);

const deletePushSubscriptionStmt = db.prepare(`
  DELETE FROM push_subscriptions
  WHERE endpoint = ?
`);

export async function persistDealerTurnToSqlite({ sessionId, userMessage, aiResult, timestamp }) {
  const entities = aiResult?.entities || {};
  const contact = entities.contact || {};

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO leads (
            session_id, name, source, language, intent, status, assigned_to, priority, mode, model, budget, date_pref, email, phone, last_intent, last_source, last_message_at, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          ON CONFLICT(session_id) DO UPDATE SET
            name = EXCLUDED.name,
            source = EXCLUDED.source,
            language = EXCLUDED.language,
            intent = EXCLUDED.intent,
            status = EXCLUDED.status,
            assigned_to = EXCLUDED.assigned_to,
            priority = EXCLUDED.priority,
            mode = EXCLUDED.mode,
            model = EXCLUDED.model,
            budget = EXCLUDED.budget,
            date_pref = EXCLUDED.date_pref,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            last_intent = EXCLUDED.last_intent,
            last_source = EXCLUDED.last_source,
            last_message_at = EXCLUDED.last_message_at,
            updated_at = EXCLUDED.updated_at
        `,
        [
          sessionId,
          null,
          "bot",
          null,
          aiResult?.intent ?? null,
          "QUALIFYING",
          null,
          "NORMAL",
          "BOT",
          entities.model ?? null,
          entities.budget ?? null,
          entities.date ?? null,
          contact.email ?? null,
          contact.phone ?? null,
          aiResult?.intent ?? null,
          aiResult?.source ?? "fallback",
          timestamp,
          timestamp,
          timestamp
        ]
      );

      await client.query(
        `
          INSERT INTO messages (session_id, role, direction, content, intent, source, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7), ($1,$8,$9,$10,$11,$12,$7)
        `,
        [
          sessionId,
          "user",
          "in",
          userMessage || "",
          aiResult?.intent ?? null,
          aiResult?.source ?? "fallback",
          timestamp,
          "assistant",
          "out",
          aiResult?.reply || "",
          aiResult?.intent ?? null,
          aiResult?.source ?? "fallback"
        ]
      );

      await client.query("COMMIT");
      return;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // noop
      }
      throw error;
    } finally {
      client.release();
    }
  }

  try {
    db.exec("BEGIN");

    upsertLeadStmt.run({
      session_id: sessionId,
      name: null,
      source: "bot",
      language: null,
      intent: aiResult?.intent ?? null,
      status: "QUALIFYING",
      assigned_to: null,
      priority: "NORMAL",
      mode: "BOT",
      model: entities.model ?? null,
      budget: entities.budget ?? null,
      date_pref: entities.date ?? null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      last_intent: aiResult?.intent ?? null,
      last_source: aiResult?.source ?? "fallback",
      last_message_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp
    });

    insertMessageStmt.run(
      sessionId,
      "user",
      "in",
      userMessage || "",
      aiResult?.intent ?? null,
      aiResult?.source ?? "fallback",
      timestamp
    );

    insertMessageStmt.run(
      sessionId,
      "assistant",
      "out",
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

export async function persistDealerFeedbackToSqlite({ sessionId, rating, comment = "", reply = "" }) {
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query(
      `
        INSERT INTO feedback (session_id, rating, comment, reply, created_at)
        VALUES ($1,$2,$3,$4,$5)
      `,
      [sessionId, rating, comment, reply, new Date().toISOString()]
    );
    return;
  }

  insertFeedbackStmt.run(sessionId, rating, comment, reply, new Date().toISOString());
}

export async function persistIncomingUserMessage({ sessionId, userMessage = "", source = "manual-mode", intent = null }) {
  const timestamp = new Date().toISOString();
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query(
      `
        INSERT INTO messages (session_id, role, direction, content, intent, source, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [sessionId, "user", "in", userMessage, intent, source, timestamp]
    );
    return;
  }
  insertMessageStmt.run(sessionId, "user", "in", userMessage, intent, source, timestamp);
}

export async function persistOutgoingAssistantMessage({
  sessionId,
  assistantMessage = "",
  source = "manual-agent",
  intent = "manual_reply"
}) {
  const timestamp = new Date().toISOString();
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query(
      `
        INSERT INTO messages (session_id, role, direction, content, intent, source, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [sessionId, "assistant", "out", assistantMessage, intent, source, timestamp]
    );
    return;
  }
  insertMessageStmt.run(sessionId, "assistant", "out", assistantMessage, intent, source, timestamp);
}

export async function markProcessedInboundMessage({
  messageKey,
  sessionId,
  channel = "unknown",
  createdAt = new Date().toISOString()
}) {
  const safeKey = String(messageKey || "").trim();
  if (!safeKey) return false;

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const res = await pgPool.query(
      `
        INSERT INTO processed_messages (message_key, session_id, channel, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(message_key) DO NOTHING
        RETURNING message_key
      `,
      [safeKey, sessionId, channel, createdAt]
    );
    return Number(res.rowCount || 0) > 0;
  }

  const insert = db.prepare(
    `
      INSERT OR IGNORE INTO processed_messages (message_key, session_id, channel, created_at)
      VALUES (?, ?, ?, ?)
    `
  );
  const result = insert.run(safeKey, sessionId, channel, createdAt);
  return Number(result.changes || 0) > 0;
}

export async function cleanupProcessedInboundMessages({ olderThanHours = 48 } = {}) {
  const safeHours = Math.max(1, Number(olderThanHours || 48));
  const thresholdIso = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query(`DELETE FROM processed_messages WHERE created_at < $1`, [thresholdIso]);
    return;
  }

  db.prepare(`DELETE FROM processed_messages WHERE created_at < ?`).run(thresholdIso);
}

export async function persistConversationEvent({
  sessionId,
  channel = "unknown",
  userId = null,
  copyVariant = null,
  action = null,
  intent = null,
  activeFlow = null,
  missingFields = null,
  latencyMs = null,
  error = null,
  createdAt = new Date().toISOString()
}) {
  const missingSerialized = Array.isArray(missingFields) ? missingFields.join(",") : missingFields;

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query(
      `
        INSERT INTO conversation_events (
          session_id, channel, user_id, copy_variant, action, intent, active_flow, missing_fields, latency_ms, error, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [sessionId, channel, userId, copyVariant, action, intent, activeFlow, missingSerialized, latencyMs, error, createdAt]
    );
    return;
  }

  db.prepare(
    `
      INSERT INTO conversation_events (
        session_id, channel, user_id, copy_variant, action, intent, active_flow, missing_fields, latency_ms, error, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(sessionId, channel, userId, copyVariant, action, intent, activeFlow, missingSerialized, latencyMs, error, createdAt);
}

export async function getConversationSettings(sessionId) {
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
        SELECT session_id, bot_enabled, last_read_at, updated_at
        FROM conversation_settings
        WHERE session_id = $1
        LIMIT 1
      `,
      [sessionId]
    );

    const row = result.rows?.[0];
    if (!row) {
      return {
        session_id: sessionId,
        bot_enabled: 1,
        last_read_at: null,
        updated_at: null
      };
    }
    return row;
  }

  const row = db
    .prepare(
      `
      SELECT session_id, bot_enabled, last_read_at, updated_at
      FROM conversation_settings
      WHERE session_id = ?
      LIMIT 1
      `
    )
    .get(sessionId);

  if (!row) {
    return {
      session_id: sessionId,
      bot_enabled: 1,
      last_read_at: null,
      updated_at: null
    };
  }

  return row;
}

export async function setConversationBotEnabled(sessionId, enabled) {
  const now = new Date().toISOString();
  const current = await getConversationSettings(sessionId);

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query(
      `
        INSERT INTO conversation_settings (session_id, bot_enabled, last_read_at, updated_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT(session_id) DO UPDATE SET
          bot_enabled = EXCLUDED.bot_enabled,
          last_read_at = EXCLUDED.last_read_at,
          updated_at = EXCLUDED.updated_at
      `,
      [sessionId, enabled ? 1 : 0, current.last_read_at ?? null, now]
    );
    return getConversationSettings(sessionId);
  }

  upsertConversationSettingsStmt.run(sessionId, enabled ? 1 : 0, current.last_read_at ?? null, now);
  return getConversationSettings(sessionId);
}

export async function markConversationRead(sessionId) {
  const now = new Date().toISOString();
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query(
      `
        INSERT INTO conversation_settings (session_id, bot_enabled, last_read_at, updated_at)
        VALUES ($1, 1, $2, $3)
        ON CONFLICT(session_id) DO UPDATE SET
          last_read_at = EXCLUDED.last_read_at,
          updated_at = EXCLUDED.updated_at
      `,
      [sessionId, now, now]
    );
    return getConversationSettings(sessionId);
  }

  markConversationReadStmt.run(sessionId, now, now);
  return getConversationSettings(sessionId);
}

export async function upsertPushSubscription({
  endpoint,
  p256dh,
  auth,
  userAgent = ""
}) {
  const now = new Date().toISOString();
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query(
      `
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(endpoint) DO UPDATE SET
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth,
          user_agent = EXCLUDED.user_agent,
          updated_at = EXCLUDED.updated_at
      `,
      [endpoint, p256dh, auth, userAgent || null, now, now]
    );
    return { ok: true };
  }

  upsertPushSubscriptionStmt.run(endpoint, p256dh, auth, userAgent || null, now, now);
  return { ok: true };
}

export async function deletePushSubscription(endpoint) {
  if (!endpoint) return { ok: true };

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
    return { ok: true };
  }

  deletePushSubscriptionStmt.run(endpoint);
  return { ok: true };
}

export async function listPushSubscriptions() {
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
        SELECT endpoint, p256dh, auth
        FROM push_subscriptions
        ORDER BY updated_at DESC
      `
    );
    return (result.rows || []).map((row) => ({
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth
      }
    }));
  }

  const rows = db
    .prepare(
      `
      SELECT endpoint, p256dh, auth
      FROM push_subscriptions
      ORDER BY updated_at DESC
      `
    )
    .all();

  return rows.map((row) => ({
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth
    }
  }));
}

export async function listDealerConversations({ limit = 100, query = "" } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 100;
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const hasQuery = normalizedQuery.length > 0;

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
        SELECT
          m.session_id AS session_id,
          MAX(m.created_at) AS updated_at,
          SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)::int AS user_messages,
          SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END)::int AS assistant_messages,
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
          ) AS last_role,
          COALESCE(s.bot_enabled, 1) AS bot_enabled,
          s.last_read_at AS last_read_at,
          COALESCE(l.status, 'NEW') AS lead_status,
          COALESCE(l.priority, 'NORMAL') AS lead_priority,
          COALESCE(l.mode, 'BOT') AS lead_mode,
          l.name AS lead_name,
          l.phone AS lead_phone,
          (
            SELECT COUNT(1)::int
            FROM messages um
            WHERE um.session_id = m.session_id
              AND um.role = 'user'
              AND (s.last_read_at IS NULL OR um.created_at > s.last_read_at)
          ) AS unread_count
        FROM messages m
        LEFT JOIN conversation_settings s ON s.session_id = m.session_id
        LEFT JOIN leads l ON l.session_id = m.session_id
        ${hasQuery ? "WHERE (LOWER(m.session_id) LIKE $1 OR LOWER(COALESCE(l.name,'')) LIKE $1 OR LOWER(COALESCE(l.phone,'')) LIKE $1)" : ""}
        GROUP BY m.session_id, s.bot_enabled, s.last_read_at, l.status, l.priority, l.mode, l.name, l.phone
        ORDER BY updated_at DESC
        LIMIT $${hasQuery ? 2 : 1}
      `,
      hasQuery ? [`%${normalizedQuery}%`, safeLimit] : [safeLimit]
    );
    return result.rows || [];
  }

  const sql = `
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
        ) AS last_role,
        COALESCE(s.bot_enabled, 1) AS bot_enabled,
        s.last_read_at AS last_read_at,
        COALESCE(l.status, 'NEW') AS lead_status,
        COALESCE(l.priority, 'NORMAL') AS lead_priority,
        COALESCE(l.mode, 'BOT') AS lead_mode,
        l.name AS lead_name,
        l.phone AS lead_phone,
        (
          SELECT COUNT(1)
          FROM messages um
          WHERE um.session_id = m.session_id
            AND um.role = 'user'
            AND (
              s.last_read_at IS NULL OR um.created_at > s.last_read_at
            )
        ) AS unread_count
      FROM messages m
      LEFT JOIN conversation_settings s ON s.session_id = m.session_id
      LEFT JOIN leads l ON l.session_id = m.session_id
      ${hasQuery ? "WHERE (LOWER(m.session_id) LIKE ? OR LOWER(COALESCE(l.name,'')) LIKE ? OR LOWER(COALESCE(l.phone,'')) LIKE ?) " : ""}
      GROUP BY m.session_id, s.bot_enabled, s.last_read_at, l.status, l.priority, l.mode, l.name, l.phone
      ORDER BY updated_at DESC
      LIMIT ?
    `;

  const statement = db.prepare(sql);
  const rows = hasQuery
    ? statement.all(`%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`, safeLimit)
    : statement.all(safeLimit);

  return rows;
}

export async function getConsecutiveAssistantMessagesSinceLastUser(sessionId, { maxScan = 20 } = {}) {
  if (!sessionId) return 0;
  const safeScan = Number.isFinite(Number(maxScan)) ? Math.max(1, Math.min(200, Number(maxScan))) : 20;

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
        SELECT role
        FROM messages
        WHERE session_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `,
      [sessionId, safeScan]
    );
    let streak = 0;
    for (const row of result.rows || []) {
      if (row.role === "assistant") {
        streak += 1;
        continue;
      }
      if (row.role === "user") break;
    }
    return streak;
  }

  const rows = db
    .prepare(
      `
      SELECT role
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
      `
    )
    .all(sessionId, safeScan);

  let streak = 0;
  for (const row of rows) {
    if (row.role === "assistant") {
      streak += 1;
      continue;
    }
    if (row.role === "user") break;
  }
  return streak;
}

export async function hasWelcomeMessageSent(sessionId) {
  if (!sessionId) return false;

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
        SELECT 1
        FROM messages
        WHERE session_id = $1
          AND role = 'assistant'
          AND (source = 'greeting-fastpath' OR intent = 'welcome')
        LIMIT 1
      `,
      [sessionId]
    );
    return Boolean(result.rows?.length);
  }

  const row = db
    .prepare(
      `
      SELECT 1
      FROM messages
      WHERE session_id = ?
        AND role = 'assistant'
        AND (source = 'greeting-fastpath' OR intent = 'welcome')
      LIMIT 1
      `
    )
    .get(sessionId);

  return Boolean(row);
}

export async function getLatestAssistantIntroAt(sessionId) {
  if (!sessionId) return null;
  const introPatternA = "%Soy el asistente virtual de Empire Rey%";
  const introPatternB = "%Soy el asistente automático de Empire Rey Auto Sales%";

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
        SELECT created_at
        FROM messages
        WHERE session_id = $1
          AND role = 'assistant'
          AND (
            content ILIKE $2
            OR content ILIKE $3
            OR source = 'greeting-fastpath'
            OR intent = 'welcome'
          )
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [sessionId, introPatternA, introPatternB]
    );
    return result.rows?.[0]?.created_at || null;
  }

  const row = db
    .prepare(
      `
      SELECT created_at
      FROM messages
      WHERE session_id = ?
        AND role = 'assistant'
        AND (
          content LIKE ?
          OR content LIKE ?
          OR source = 'greeting-fastpath'
          OR intent = 'welcome'
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      `
    )
    .get(sessionId, introPatternA, introPatternB);

  return row?.created_at || null;
}

export async function listDealerMessagesBySession(sessionId, { limit = 200, beforeId = null } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(1000, Number(limit))) : 200;
  const safeBeforeId = Number.isFinite(Number(beforeId)) ? Number(beforeId) : null;

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = safeBeforeId
      ? await pgPool.query(
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
            WHERE session_id = $1
              AND id < $2
            ORDER BY id DESC
            LIMIT $3
          `,
          [sessionId, safeBeforeId, safeLimit]
        )
      : await pgPool.query(
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
            WHERE session_id = $1
            ORDER BY id DESC
            LIMIT $2
          `,
          [sessionId, safeLimit]
        );
    return (result.rows || []).reverse();
  }

  const rows = safeBeforeId
    ? db
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
            AND id < ?
          ORDER BY id DESC
          LIMIT ?
          `
        )
        .all(sessionId, safeBeforeId, safeLimit)
    : db
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
          ORDER BY id DESC
          LIMIT ?
          `
        )
        .all(sessionId, safeLimit);

  return rows.reverse();
}

const LEAD_PIPELINE_STATUSES = new Set([
  "NEW",
  "QUALIFYING",
  "QUALIFIED",
  "APPT_PENDING",
  "BOOKED",
  "NO_RESPONSE",
  "CLOSED_WON",
  "CLOSED_LOST"
]);

function normalizeLeadStatus(value, fallback = "NEW") {
  const raw = String(value || fallback).trim().toUpperCase();
  if (LEAD_PIPELINE_STATUSES.has(raw)) return raw;
  return fallback;
}

export async function getLeadBySessionId(sessionId) {
  if (!sessionId) return null;
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
        SELECT session_id, name, source, language, intent, status, assigned_to, priority, mode, model, budget, date_pref, email, phone, last_intent, last_source, last_message_at, created_at, updated_at
        FROM leads
        WHERE session_id = $1
        LIMIT 1
      `,
      [sessionId]
    );
    return result.rows?.[0] || null;
  }

  return (
    db
      .prepare(
        `
        SELECT session_id, name, source, language, intent, status, assigned_to, priority, mode, model, budget, date_pref, email, phone, last_intent, last_source, last_message_at, created_at, updated_at
        FROM leads
        WHERE session_id = ?
        LIMIT 1
        `
      )
      .get(sessionId) || null
  );
}

export async function upsertLeadProfile({
  sessionId,
  phone = null,
  name = null,
  source = "whatsapp",
  language = null,
  intent = null,
  status = "NEW",
  assignedTo = null,
  priority = "NORMAL",
  mode = "BOT",
  datePref = null,
  date_pref = null,
  lastMessageAt = null
} = {}) {
  if (!sessionId) return null;
  const now = new Date().toISOString();
  const existing = await getLeadBySessionId(sessionId);
  const next = {
    session_id: sessionId,
    name: name ?? existing?.name ?? null,
    source: source ?? existing?.source ?? "whatsapp",
    language: language ?? existing?.language ?? null,
    intent: intent ?? existing?.intent ?? null,
    status: normalizeLeadStatus(status, existing?.status || "NEW"),
    assigned_to: assignedTo ?? existing?.assigned_to ?? null,
    priority: String(priority ?? existing?.priority ?? "NORMAL").toUpperCase(),
    mode: String(mode ?? existing?.mode ?? "BOT").toUpperCase(),
    model: existing?.model ?? null,
    budget: existing?.budget ?? null,
    date_pref: datePref ?? date_pref ?? existing?.date_pref ?? null,
    email: existing?.email ?? null,
    phone: phone ?? existing?.phone ?? null,
    last_intent: intent ?? existing?.last_intent ?? null,
    last_source: source ?? existing?.last_source ?? "whatsapp",
    last_message_at: lastMessageAt || now,
    created_at: existing?.created_at || now,
    updated_at: now
  };

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query(
      `
        INSERT INTO leads (
          session_id, name, source, language, intent, status, assigned_to, priority, mode, model, budget, date_pref, email, phone, last_intent, last_source, last_message_at, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT(session_id) DO UPDATE SET
          name = EXCLUDED.name,
          source = EXCLUDED.source,
          language = EXCLUDED.language,
          intent = EXCLUDED.intent,
          status = EXCLUDED.status,
          assigned_to = EXCLUDED.assigned_to,
          priority = EXCLUDED.priority,
          mode = EXCLUDED.mode,
          model = EXCLUDED.model,
          budget = EXCLUDED.budget,
          date_pref = EXCLUDED.date_pref,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          last_intent = EXCLUDED.last_intent,
          last_source = EXCLUDED.last_source,
          last_message_at = EXCLUDED.last_message_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        next.session_id,
        next.name,
        next.source,
        next.language,
        next.intent,
        next.status,
        next.assigned_to,
        next.priority,
        next.mode,
        next.model,
        next.budget,
        next.date_pref,
        next.email,
        next.phone,
        next.last_intent,
        next.last_source,
        next.last_message_at,
        next.created_at,
        next.updated_at
      ]
    );
    return getLeadBySessionId(sessionId);
  }

  upsertLeadStmt.run(next);
  return getLeadBySessionId(sessionId);
}

export async function updateLeadStatus(sessionId, status, extras = {}) {
  return upsertLeadProfile({
    sessionId,
    status,
    ...extras
  });
}

export async function listLeads({ limit = 200, status = "", query = "" } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 200;
  const normalizedStatus = String(status || "").trim().toUpperCase();
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const hasStatus = normalizedStatus.length > 0;
  const hasQuery = normalizedQuery.length > 0;

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const where = [];
    const params = [];
    let idx = 1;
    if (hasStatus) {
      where.push(`UPPER(status) = $${idx++}`);
      params.push(normalizedStatus);
    }
    if (hasQuery) {
      where.push(`(LOWER(session_id) LIKE $${idx} OR LOWER(COALESCE(name,'')) LIKE $${idx} OR LOWER(COALESCE(phone,'')) LIKE $${idx})`);
      params.push(`%${normalizedQuery}%`);
      idx += 1;
    }

    params.push(safeLimit);
    const result = await pgPool.query(
      `
        SELECT session_id, name, source, language, intent, status, assigned_to, priority, mode, phone, last_message_at, updated_at
        FROM leads
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(last_message_at, updated_at) DESC
        LIMIT $${params.length}
      `,
      params
    );
    return result.rows || [];
  }

  const where = [];
  const params = [];
  if (hasStatus) {
    where.push("UPPER(status) = ?");
    params.push(normalizedStatus);
  }
  if (hasQuery) {
    where.push("(LOWER(session_id) LIKE ? OR LOWER(COALESCE(name,'')) LIKE ? OR LOWER(COALESCE(phone,'')) LIKE ?)");
    params.push(`%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`);
  }
  params.push(safeLimit);

  return db
    .prepare(
      `
      SELECT session_id, name, source, language, intent, status, assigned_to, priority, mode, phone, last_message_at, updated_at
      FROM leads
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(last_message_at, updated_at) DESC
      LIMIT ?
      `
    )
    .all(...params);
}

function normalizeAppointmentStatus(status) {
  const value = String(status || "PENDING").trim().toUpperCase();
  const allowed = new Set(["PENDING", "CONFIRMED", "CANCELLED", "RESCHEDULED", "NO_SHOW", "COMPLETED"]);
  return allowed.has(value) ? value : "PENDING";
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? []);
  } catch {
    return "[]";
  }
}

function safeJsonParse(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeAppointmentRow(row) {
  if (!row) return null;
  return {
    ...row,
    proposal_options: Array.isArray(row.proposal_options)
      ? row.proposal_options
      : safeJsonParse(row.proposal_options)
  };
}

export async function createAppointment({
  leadSessionId,
  lead_session_id,
  scheduledAt,
  scheduled_at,
  vehicleId = null,
  vehicle_id = null,
  status = "PENDING",
  confirmationState = null,
  confirmation_state,
  proposalOptions = [],
  proposal_options,
  notes = ""
} = {}) {
  const safeLeadSessionId = leadSessionId ?? lead_session_id ?? null;
  const safeScheduledAt = scheduledAt ?? scheduled_at ?? null;
  const safeVehicleId = vehicleId ?? vehicle_id ?? null;
  const safeConfirmationState = confirmationState ?? confirmation_state ?? "PROPOSED";
  const safeProposalOptions = proposalOptions ?? proposal_options ?? [];

  if (!safeLeadSessionId || !safeScheduledAt) {
    throw new Error("lead_session_id and scheduled_at are required");
  }

  const now = new Date().toISOString();
  const normalizedStatus = normalizeAppointmentStatus(status);
  const proposalJson = safeJsonStringify(safeProposalOptions);

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
        INSERT INTO appointments (
          lead_session_id, scheduled_at, vehicle_id, status, confirmation_state, proposal_options, notes, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
        RETURNING *
      `,
      [safeLeadSessionId, safeScheduledAt, safeVehicleId, normalizedStatus, safeConfirmationState, proposalJson, notes, now, now]
    );
    return normalizeAppointmentRow(result.rows?.[0] || null);
  }

  const insertRes = db
    .prepare(
      `
      INSERT INTO appointments (
        lead_session_id, scheduled_at, vehicle_id, status, confirmation_state, proposal_options, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(safeLeadSessionId, safeScheduledAt, safeVehicleId, normalizedStatus, safeConfirmationState, proposalJson, notes, now, now);

  return normalizeAppointmentRow(
    db.prepare(`SELECT * FROM appointments WHERE id = ? LIMIT 1`).get(Number(insertRes.lastInsertRowid)) || null
  );
}

export async function getAppointmentById(id) {
  const safeId = Number(id);
  if (!Number.isFinite(safeId)) return null;
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(`SELECT * FROM appointments WHERE id = $1 LIMIT 1`, [safeId]);
    return normalizeAppointmentRow(result.rows?.[0] || null);
  }
  return normalizeAppointmentRow(db.prepare(`SELECT * FROM appointments WHERE id = ? LIMIT 1`).get(safeId) || null);
}

export async function listAppointments({ from = null, to = null, status = "", limit = 500 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(1000, Number(limit))) : 500;
  const normalizedStatus = String(status || "").trim().toUpperCase();
  const hasStatus = normalizedStatus.length > 0;

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const where = [];
    const params = [];
    let idx = 1;
    if (from) {
      where.push(`scheduled_at >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      where.push(`scheduled_at <= $${idx++}`);
      params.push(to);
    }
    if (hasStatus) {
      where.push(`UPPER(status) = $${idx++}`);
      params.push(normalizedStatus);
    }
    params.push(safeLimit);
    const result = await pgPool.query(
      `
      SELECT a.*, l.name AS lead_name, l.phone AS lead_phone, l.priority AS lead_priority, l.status AS lead_status
      FROM appointments a
      LEFT JOIN leads l ON l.session_id = a.lead_session_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.scheduled_at ASC
      LIMIT $${params.length}
      `,
      params
    );
    return (result.rows || []).map((row) => normalizeAppointmentRow(row));
  }

  const where = [];
  const params = [];
  if (from) {
    where.push("a.scheduled_at >= ?");
    params.push(from);
  }
  if (to) {
    where.push("a.scheduled_at <= ?");
    params.push(to);
  }
  if (hasStatus) {
    where.push("UPPER(a.status) = ?");
    params.push(normalizedStatus);
  }
  params.push(safeLimit);

  const rows = db
    .prepare(
      `
      SELECT a.*, l.name AS lead_name, l.phone AS lead_phone, l.priority AS lead_priority, l.status AS lead_status
      FROM appointments a
      LEFT JOIN leads l ON l.session_id = a.lead_session_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.scheduled_at ASC
      LIMIT ?
      `
    )
    .all(...params);

  return rows.map((row) => normalizeAppointmentRow(row));
}

export async function updateAppointment(id, patch = {}) {
  const existing = await getAppointmentById(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const next = {
    scheduled_at: patch.scheduledAt ?? patch.scheduled_at ?? existing.scheduled_at,
    vehicle_id: patch.vehicleId ?? patch.vehicle_id ?? existing.vehicle_id ?? null,
    status: normalizeAppointmentStatus(patch.status ?? existing.status),
    confirmation_state: patch.confirmationState ?? patch.confirmation_state ?? existing.confirmation_state ?? "PROPOSED",
    proposal_options: patch.proposalOptions ?? patch.proposal_options ?? existing.proposal_options ?? [],
    notes: patch.notes ?? existing.notes ?? "",
    reminder_2h_sent_at: patch.reminder2hSentAt ?? patch.reminder_2h_sent_at ?? existing.reminder_2h_sent_at ?? null,
    reminder_15m_sent_at: patch.reminder15mSentAt ?? patch.reminder_15m_sent_at ?? existing.reminder_15m_sent_at ?? null,
    confirmed_at: patch.confirmedAt ?? patch.confirmed_at ?? existing.confirmed_at ?? null,
    cancelled_at: patch.cancelledAt ?? patch.cancelled_at ?? existing.cancelled_at ?? null,
    updated_at: now
  };

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
      UPDATE appointments
      SET scheduled_at = $1, vehicle_id = $2, status = $3, confirmation_state = $4, proposal_options = $5::jsonb, notes = $6,
          reminder_2h_sent_at = $7, reminder_15m_sent_at = $8, confirmed_at = $9, cancelled_at = $10, updated_at = $11
      WHERE id = $12
      RETURNING *
      `,
      [
        next.scheduled_at,
        next.vehicle_id,
        next.status,
        next.confirmation_state,
        safeJsonStringify(next.proposal_options),
        next.notes,
        next.reminder_2h_sent_at,
        next.reminder_15m_sent_at,
        next.confirmed_at,
        next.cancelled_at,
        next.updated_at,
        Number(id)
      ]
    );
    return normalizeAppointmentRow(result.rows?.[0] || null);
  }

  db
    .prepare(
      `
      UPDATE appointments
      SET scheduled_at = ?, vehicle_id = ?, status = ?, confirmation_state = ?, proposal_options = ?, notes = ?,
          reminder_2h_sent_at = ?, reminder_15m_sent_at = ?, confirmed_at = ?, cancelled_at = ?, updated_at = ?
      WHERE id = ?
      `
    )
    .run(
      next.scheduled_at,
      next.vehicle_id,
      next.status,
      next.confirmation_state,
      safeJsonStringify(next.proposal_options),
      next.notes,
      next.reminder_2h_sent_at,
      next.reminder_15m_sent_at,
      next.confirmed_at,
      next.cancelled_at,
      next.updated_at,
      Number(id)
    );

  return getAppointmentById(id);
}

export async function deleteAppointment(id) {
  const existing = await getAppointmentById(id);
  if (!existing) return false;

  const safeId = Number(id);
  if (!Number.isFinite(safeId) || safeId <= 0) return false;

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    await pgPool.query("DELETE FROM appointments WHERE id = $1", [safeId]);
    return true;
  }

  db.prepare("DELETE FROM appointments WHERE id = ?").run(safeId);
  return true;
}

export async function deleteConversationBySessionId(sessionId) {
  const safeSessionId = String(sessionId || "").trim();
  if (!safeSessionId) return { ok: false, deleted: 0 };

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const appointments = await client.query("DELETE FROM appointments WHERE lead_session_id = $1", [safeSessionId]);
      const messages = await client.query("DELETE FROM messages WHERE session_id = $1", [safeSessionId]);
      const settings = await client.query("DELETE FROM conversation_settings WHERE session_id = $1", [safeSessionId]);
      const leads = await client.query("DELETE FROM leads WHERE session_id = $1", [safeSessionId]);
      await client.query("COMMIT");
      const deleted =
        Number(appointments.rowCount || 0) +
        Number(messages.rowCount || 0) +
        Number(settings.rowCount || 0) +
        Number(leads.rowCount || 0);
      return { ok: true, deleted };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const runSqliteDelete = db.transaction((sid) => {
    const appointments = db.prepare("DELETE FROM appointments WHERE lead_session_id = ?").run(sid);
    const messages = db.prepare("DELETE FROM messages WHERE session_id = ?").run(sid);
    const settings = db.prepare("DELETE FROM conversation_settings WHERE session_id = ?").run(sid);
    const leads = db.prepare("DELETE FROM leads WHERE session_id = ?").run(sid);
    return (
      Number(appointments.changes || 0) +
      Number(messages.changes || 0) +
      Number(settings.changes || 0) +
      Number(leads.changes || 0)
    );
  });

  const deleted = runSqliteDelete(safeSessionId);
  return { ok: true, deleted };
}

export async function purgeConversationsByPrefixes(prefixes = []) {
  const cleanPrefixes = Array.isArray(prefixes)
    ? prefixes.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  if (!cleanPrefixes.length) return { ok: true, deleted: 0 };

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const patterns = cleanPrefixes.map((p) => `${p}%`);
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const appointments = await client.query("DELETE FROM appointments WHERE lead_session_id LIKE ANY($1::text[])", [patterns]);
      const messages = await client.query("DELETE FROM messages WHERE session_id LIKE ANY($1::text[])", [patterns]);
      const settings = await client.query("DELETE FROM conversation_settings WHERE session_id LIKE ANY($1::text[])", [patterns]);
      const leads = await client.query("DELETE FROM leads WHERE session_id LIKE ANY($1::text[])", [patterns]);
      await client.query("COMMIT");
      const deleted =
        Number(appointments.rowCount || 0) +
        Number(messages.rowCount || 0) +
        Number(settings.rowCount || 0) +
        Number(leads.rowCount || 0);
      return { ok: true, deleted };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const where = cleanPrefixes.map(() => "session_id LIKE ?").join(" OR ");
  const args = cleanPrefixes.map((p) => `${p}%`);
  const runSqlitePurge = db.transaction((clause, values) => {
    const appointments = db.prepare(`DELETE FROM appointments WHERE ${clause.replace(/session_id/g, "lead_session_id")}`).run(...values);
    const messages = db.prepare(`DELETE FROM messages WHERE ${clause}`).run(...values);
    const settings = db.prepare(`DELETE FROM conversation_settings WHERE ${clause}`).run(...values);
    const leads = db.prepare(`DELETE FROM leads WHERE ${clause}`).run(...values);
    return (
      Number(appointments.changes || 0) +
      Number(messages.changes || 0) +
      Number(settings.changes || 0) +
      Number(leads.changes || 0)
    );
  });
  const deleted = runSqlitePurge(where, args);
  return { ok: true, deleted };
}

export async function findAppointmentsForReminder({ minutesBefore = 120 } = {}) {
  const now = new Date();
  const targetStart = new Date(now.getTime() + (minutesBefore - 1) * 60_000).toISOString();
  const targetEnd = new Date(now.getTime() + minutesBefore * 60_000).toISOString();
  const reminderField = minutesBefore <= 20 ? "reminder_15m_sent_at" : "reminder_2h_sent_at";

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
      SELECT a.*, l.phone AS lead_phone
      FROM appointments a
      LEFT JOIN leads l ON l.session_id = a.lead_session_id
      WHERE a.status IN ('PENDING', 'CONFIRMED')
        AND a.scheduled_at >= $1
        AND a.scheduled_at < $2
        AND a.${reminderField} IS NULL
      ORDER BY a.scheduled_at ASC
      `,
      [targetStart, targetEnd]
    );
    return result.rows || [];
  }

  return db
    .prepare(
      `
      SELECT a.*, l.phone AS lead_phone
      FROM appointments a
      LEFT JOIN leads l ON l.session_id = a.lead_session_id
      WHERE a.status IN ('PENDING', 'CONFIRMED')
        AND a.scheduled_at >= ?
        AND a.scheduled_at < ?
        AND a.${reminderField} IS NULL
      ORDER BY a.scheduled_at ASC
      `
    )
    .all(targetStart, targetEnd);
}

export async function getLatestOpenAppointmentForLead(leadSessionId) {
  if (!leadSessionId) return null;
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
      SELECT *
      FROM appointments
      WHERE lead_session_id = $1
        AND status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
      `,
      [leadSessionId]
    );
    return normalizeAppointmentRow(result.rows?.[0] || null);
  }

  return normalizeAppointmentRow(
    db
      .prepare(
        `
      SELECT *
      FROM appointments
      WHERE lead_session_id = ?
        AND status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
      `
      )
      .get(leadSessionId) || null
  );
}

export async function isAppointmentSlotAvailable({ scheduledAt, excludeAppointmentId = null, windowMinutes = 45 } = {}) {
  const when = new Date(scheduledAt || "");
  if (Number.isNaN(when.getTime())) return false;
  const halfWindowMs = Math.max(5, Number(windowMinutes) || 45) * 60_000;
  const from = new Date(when.getTime() - halfWindowMs).toISOString();
  const to = new Date(when.getTime() + halfWindowMs).toISOString();

  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const params = [from, to];
    let sql = `
      SELECT COUNT(1)::int AS value
      FROM appointments
      WHERE status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
        AND scheduled_at >= $1
        AND scheduled_at <= $2
    `;
    if (excludeAppointmentId != null) {
      params.push(Number(excludeAppointmentId));
      sql += ` AND id <> $${params.length}`;
    }
    const result = await pgPool.query(sql, params);
    const count = Number(result.rows?.[0]?.value || 0);
    return count === 0;
  }

  let sql = `
    SELECT COUNT(1) AS value
    FROM appointments
    WHERE status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
      AND scheduled_at >= ?
      AND scheduled_at <= ?
  `;
  const params = [from, to];
  if (excludeAppointmentId != null) {
    sql += ` AND id <> ?`;
    params.push(Number(excludeAppointmentId));
  }
  const row = db.prepare(sql).get(...params);
  return Number(row?.value || 0) === 0;
}

export async function getUnreadMessagesTotal() {
  if (usePgInventory && pgPool) {
    await pgMessagingReady;
    const result = await pgPool.query(
      `
        SELECT COALESCE(SUM(unread_count), 0)::int AS total
        FROM (
          SELECT
            m.session_id,
            (
              SELECT COUNT(1)::int
              FROM messages um
              LEFT JOIN conversation_settings s2 ON s2.session_id = um.session_id
              WHERE um.session_id = m.session_id
                AND um.role = 'user'
                AND (s2.last_read_at IS NULL OR um.created_at > s2.last_read_at)
            ) AS unread_count
          FROM messages m
          GROUP BY m.session_id
        ) q
      `
    );
    return Number(result.rows?.[0]?.total || 0);
  }

  const result = db
    .prepare(
      `
      SELECT COALESCE(SUM(unread_count), 0) AS total
      FROM (
        SELECT
          m.session_id,
          (
            SELECT COUNT(1)
            FROM messages um
            LEFT JOIN conversation_settings s2 ON s2.session_id = um.session_id
            WHERE um.session_id = m.session_id
              AND um.role = 'user'
              AND (s2.last_read_at IS NULL OR um.created_at > s2.last_read_at)
          ) AS unread_count
        FROM messages m
        GROUP BY m.session_id
      ) q
      `
    )
    .get();

  return Number(result?.total || 0);
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

export async function getStorageHealth() {
  if (usePgInventory && pgPool) {
    try {
      await pgMessagingReady;
      const [leadsResult, messagesResult, feedbackResult, latestLeadResult] = await Promise.all([
        pgPool.query("SELECT COUNT(*)::int AS value FROM leads"),
        pgPool.query("SELECT COUNT(*)::int AS value FROM messages"),
        pgPool.query("SELECT COUNT(*)::int AS value FROM feedback"),
        pgPool.query(
          "SELECT session_id, model, last_intent, last_source, updated_at FROM leads ORDER BY updated_at DESC LIMIT 1"
        )
      ]);

      return {
        ok: true,
        engine: "postgres",
        configuredWith: process.env.NEON_DATABASE_URL ? "NEON_DATABASE_URL" : "DATABASE_URL",
        counts: {
          leads: leadsResult.rows?.[0]?.value ?? 0,
          messages: messagesResult.rows?.[0]?.value ?? 0,
          feedback: feedbackResult.rows?.[0]?.value ?? 0
        },
        latestLead: latestLeadResult.rows?.[0] || null
      };
    } catch (error) {
      return {
        ok: false,
        engine: "postgres",
        configuredWith: process.env.NEON_DATABASE_URL ? "NEON_DATABASE_URL" : "DATABASE_URL",
        reason: error?.message || "postgres check failed"
      };
    }
  }

  return {
    engine: "sqlite",
    configuredWith: "SQLITE_PATH",
    ...getSqliteHealth()
  };
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
