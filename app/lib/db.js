/**
 * SQLite (better-sqlite3) with WAL + foreign keys.
 * Path: SHOP_DB_PATH (default /data/shop.sqlite).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.SHOP_DB_PATH || "/data/shop.sqlite";

let db;

export function getDbPath() {
  return DB_PATH;
}

export function getDb() {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      stripe_customer_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      stripe_session_id TEXT UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('payment', 'subscription')),
      amount_total INTEGER,
      currency TEXT,
      status TEXT,
      kit_config_json TEXT,
      line_items_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entitlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      service_id TEXT NOT NULL,
      stripe_subscription_id TEXT,
      stripe_price_id TEXT,
      status TEXT,
      current_period_end TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (customer_id, service_id)
    );

    CREATE TABLE IF NOT EXISTS provisioning_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_id INTEGER REFERENCES orders(id),
      job_type TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_event_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** @returns {boolean} true if newly claimed (not a duplicate) */
export function claimWebhookEvent(stripeEventId, type) {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO webhook_events (stripe_event_id, type) VALUES (?, ?)`,
    )
    .run(stripeEventId, type);
  return info.changes > 0;
}

export function upsertCustomer({ email, stripeCustomerId }) {
  const database = getDb();
  const now = new Date().toISOString();
  const existing = stripeCustomerId
    ? database
        .prepare(`SELECT * FROM customers WHERE stripe_customer_id = ?`)
        .get(stripeCustomerId)
    : null;
  const byEmail = email
    ? database.prepare(`SELECT * FROM customers WHERE email = ?`).get(email)
    : null;

  const row = existing || byEmail;
  if (row) {
    database
      .prepare(
        `UPDATE customers SET
          email = COALESCE(?, email),
          stripe_customer_id = COALESCE(?, stripe_customer_id),
          updated_at = ?
        WHERE id = ?`,
      )
      .run(email || null, stripeCustomerId || null, now, row.id);
    return database.prepare(`SELECT * FROM customers WHERE id = ?`).get(row.id);
  }

  const info = database
    .prepare(
      `INSERT INTO customers (email, stripe_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(email, stripeCustomerId || null, now, now);
  return database.prepare(`SELECT * FROM customers WHERE id = ?`).get(info.lastInsertRowid);
}

export function insertOrder({
  customerId,
  stripeSessionId,
  mode,
  amountTotal,
  currency,
  status,
  kitConfigJson,
  lineItemsJson,
}) {
  const database = getDb();
  if (stripeSessionId) {
    const existing = database
      .prepare(`SELECT * FROM orders WHERE stripe_session_id = ?`)
      .get(stripeSessionId);
    if (existing) return existing;
  }
  const info = database
    .prepare(
      `INSERT INTO orders (
        customer_id, stripe_session_id, mode, amount_total, currency, status,
        kit_config_json, line_items_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      customerId,
      stripeSessionId || null,
      mode,
      amountTotal ?? null,
      currency || null,
      status || null,
      kitConfigJson || null,
      lineItemsJson || null,
    );
  return database.prepare(`SELECT * FROM orders WHERE id = ?`).get(info.lastInsertRowid);
}

export function upsertEntitlement({
  customerId,
  serviceId,
  stripeSubscriptionId,
  stripePriceId,
  status,
  currentPeriodEnd,
}) {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO entitlements (
        customer_id, service_id, stripe_subscription_id, stripe_price_id,
        status, current_period_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(customer_id, service_id) DO UPDATE SET
        stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, entitlements.stripe_subscription_id),
        stripe_price_id = COALESCE(excluded.stripe_price_id, entitlements.stripe_price_id),
        status = COALESCE(excluded.status, entitlements.status),
        current_period_end = COALESCE(excluded.current_period_end, entitlements.current_period_end),
        updated_at = excluded.updated_at`,
    )
    .run(
      customerId,
      serviceId,
      stripeSubscriptionId || null,
      stripePriceId || null,
      status || null,
      currentPeriodEnd || null,
      now,
      now,
    );
  return database
    .prepare(`SELECT * FROM entitlements WHERE customer_id = ? AND service_id = ?`)
    .get(customerId, serviceId);
}

export function insertProvisioningJob({
  customerId,
  orderId,
  jobType,
  payloadJson,
  status = "pending",
}) {
  const database = getDb();
  const now = new Date().toISOString();
  const info = database
    .prepare(
      `INSERT INTO provisioning_jobs (
        customer_id, order_id, job_type, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      customerId,
      orderId ?? null,
      jobType,
      payloadJson || null,
      status,
      now,
      now,
    );
  return database.prepare(`SELECT * FROM provisioning_jobs WHERE id = ?`).get(info.lastInsertRowid);
}
