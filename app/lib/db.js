/**
 * SQLite (better-sqlite3) with WAL + foreign keys.
 * Path: SHOP_DB_PATH (default /data/shop.sqlite).
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
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

function columnExists(database, table, column) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
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
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
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

  if (!columnExists(database, "provisioning_jobs", "notes")) {
    database.exec(`ALTER TABLE provisioning_jobs ADD COLUMN notes TEXT`);
  }

  if (!columnExists(database, "customers", "neo_ssh_public_key")) {
    database.exec(`ALTER TABLE customers ADD COLUMN neo_ssh_public_key TEXT`);
  }

  if (!columnExists(database, "customers", "gitea_deploy_key_id")) {
    database.exec(`ALTER TABLE customers ADD COLUMN gitea_deploy_key_id TEXT`);
  }

  if (!columnExists(database, "customers", "repo_slug")) {
    database.exec(`ALTER TABLE customers ADD COLUMN repo_slug TEXT`);
  }

  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_repo_slug ON customers(repo_slug) WHERE repo_slug IS NOT NULL`,
  );

  // Backfill opaque Crockford slugs for existing customers
  const missing = database
    .prepare(`SELECT id FROM customers WHERE repo_slug IS NULL OR TRIM(repo_slug) = ''`)
    .all();
  for (const row of missing) {
    ensureCustomerRepoSlug(database, row.id);
  }

  migrateProvisioningStatusCheck(database);
}

/** Recreate provisioning_jobs if CHECK lacks 'claimed' (SQLite cannot ALTER CHECK). */
function migrateProvisioningStatusCheck(database) {
  const row = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provisioning_jobs'`,
    )
    .get();
  if (!row?.sql || row.sql.includes("'claimed'")) return;

  database.exec(`
    BEGIN;
    CREATE TABLE provisioning_jobs_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_id INTEGER REFERENCES orders(id),
      job_type TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT
    );
    INSERT INTO provisioning_jobs_new (
      id, customer_id, order_id, job_type, payload_json, status,
      created_at, updated_at, notes
    )
    SELECT
      id, customer_id, order_id, job_type, payload_json, status,
      created_at, updated_at, notes
    FROM provisioning_jobs;
    DROP TABLE provisioning_jobs;
    ALTER TABLE provisioning_jobs_new RENAME TO provisioning_jobs;
    COMMIT;
  `);
}


/** Crockford base32 alphabet — no I, L, O, U (avoids 1/0 ambiguity). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Opaque 10-char Crockford base32 slug from crypto random. */
export function generateRepoSlug(length = 10) {
  const len = Math.min(Math.max(Number(length) || 10, 8), 10);
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CROCKFORD[bytes[i] % 32];
  }
  return out;
}

/**
 * Ensure customer has a unique repo_slug; generate if null/empty.
 * @returns {string|null} slug or null if customer missing
 */
export function ensureCustomerRepoSlug(databaseOrId, maybeId) {
  const database = typeof databaseOrId === "object" ? databaseOrId : getDb();
  const id = typeof databaseOrId === "object" ? maybeId : databaseOrId;
  const row = database.prepare(`SELECT id, repo_slug FROM customers WHERE id = ?`).get(id);
  if (!row) return null;
  if (row.repo_slug && String(row.repo_slug).trim()) return row.repo_slug;

  for (let attempt = 0; attempt < 12; attempt++) {
    const slug = generateRepoSlug(10);
    try {
      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE customers SET repo_slug = ?, updated_at = ? WHERE id = ? AND (repo_slug IS NULL OR TRIM(repo_slug) = '')`,
        )
        .run(slug, now, id);
      const again = database.prepare(`SELECT repo_slug FROM customers WHERE id = ?`).get(id);
      if (again?.repo_slug) return again.repo_slug;
    } catch (err) {
      // UNIQUE collision — retry
      if (!String(err.message || "").includes("UNIQUE")) throw err;
    }
  }
  throw new Error(`failed_to_allocate_repo_slug for customer ${id}`);
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
    ensureCustomerRepoSlug(database, row.id);
    return database.prepare(`SELECT * FROM customers WHERE id = ?`).get(row.id);
  }

  let slug = generateRepoSlug(10);
  let info;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      info = database
        .prepare(
          `INSERT INTO customers (email, stripe_customer_id, repo_slug, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(email, stripeCustomerId || null, slug, now, now);
      break;
    } catch (err) {
      if (!String(err.message || "").includes("UNIQUE")) throw err;
      // email/stripe or repo_slug collision — only regenerate slug for slug collisions
      if (String(err.message || "").includes("repo_slug")) {
        slug = generateRepoSlug(10);
        continue;
      }
      throw err;
    }
  }
  if (!info) throw new Error("failed_to_insert_customer");
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
  ensureCustomerRepoSlug(database, customerId);
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

export function updateCustomerEmail(id, email) {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(`UPDATE customers SET email = ?, updated_at = ? WHERE id = ?`)
    .run(email, now, id);
  return database.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
}

export function updateProvisioningJob(id, { status, notes }) {
  const database = getDb();
  const now = new Date().toISOString();
  const row = database.prepare(`SELECT * FROM provisioning_jobs WHERE id = ?`).get(id);
  if (!row) return null;
  const nextStatus = status != null ? status : row.status;
  const nextNotes = notes !== undefined ? notes : row.notes;
  database
    .prepare(
      `UPDATE provisioning_jobs SET status = ?, notes = ?, updated_at = ? WHERE id = ?`,
    )
    .run(nextStatus, nextNotes ?? null, now, id);
  return database.prepare(`SELECT * FROM provisioning_jobs WHERE id = ?`).get(id);
}

export function updateEntitlementStatus(id, status, currentPeriodEnd) {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE entitlements SET status = ?, current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE id = ?`,
    )
    .run(status, currentPeriodEnd ?? null, now, id);
  return database.prepare(`SELECT * FROM entitlements WHERE id = ?`).get(id);
}


export function getCustomerById(id) {
  return getDb().prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
}

/** @returns {null|object} null if customer missing */
export function updateCustomerSshKey(id, publicKey) {
  const database = getDb();
  const row = database.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
  if (!row) return null;
  const now = new Date().toISOString();
  const key = publicKey == null || publicKey === "" ? null : String(publicKey).trim();
  database
    .prepare(
      `UPDATE customers SET neo_ssh_public_key = ?, updated_at = ? WHERE id = ?`,
    )
    .run(key, now, id);
  return database.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
}

/** @returns {null|object} null if customer missing */
export function updateCustomerGiteaDeployKeyId(id, giteaDeployKeyId) {
  const database = getDb();
  const row = database.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
  if (!row) return null;
  const now = new Date().toISOString();
  let value = null;
  if (giteaDeployKeyId != null && String(giteaDeployKeyId).trim() !== "") {
    value = String(giteaDeployKeyId).trim();
  }
  database
    .prepare(
      `UPDATE customers SET gitea_deploy_key_id = ?, updated_at = ? WHERE id = ?`,
    )
    .run(value, now, id);
  return database.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
}

export function listProvisioningJobs({ status = "pending", limit = 50 } = {}) {
  const database = getDb();
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = database
    .prepare(
      `SELECT j.*,
              c.email AS email,
              c.stripe_customer_id AS stripe_customer_id,
              c.neo_ssh_public_key AS neo_ssh_public_key,
              c.gitea_deploy_key_id AS gitea_deploy_key_id,
              c.repo_slug AS repo_slug,
              CASE WHEN c.neo_ssh_public_key IS NOT NULL AND TRIM(c.neo_ssh_public_key) != '' THEN 1 ELSE 0 END AS has_ssh_key
       FROM provisioning_jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.status = ?
       ORDER BY j.id ASC
       LIMIT ?`,
    )
    .all(status, lim);
  for (const r of rows) {
    if (r.customer_id && (!r.repo_slug || !String(r.repo_slug).trim())) {
      r.repo_slug = ensureCustomerRepoSlug(database, r.customer_id);
    }
  }
  return rows;
}

/** Atomically pending → claimed. Returns joined row or null if not pending / missing. */
export function claimProvisioningJob(id, { worker } = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  let notesPatch = null;
  if (worker) {
    notesPatch = `claimed_by:${worker}`;
  }
  const info = database
    .prepare(
      `UPDATE provisioning_jobs SET
         status = 'claimed',
         notes = CASE
           WHEN ? IS NOT NULL AND (notes IS NULL OR notes = '') THEN ?
           WHEN ? IS NOT NULL THEN notes || ' | ' || ?
           ELSE notes
         END,
         updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(notesPatch, notesPatch, notesPatch, notesPatch, now, id);
  if (info.changes === 0) return null;
  const claimed = database
    .prepare(
      `SELECT j.*,
              c.email AS email,
              c.stripe_customer_id AS stripe_customer_id,
              c.neo_ssh_public_key AS neo_ssh_public_key,
              c.gitea_deploy_key_id AS gitea_deploy_key_id,
              c.repo_slug AS repo_slug,
              CASE WHEN c.neo_ssh_public_key IS NOT NULL AND TRIM(c.neo_ssh_public_key) != '' THEN 1 ELSE 0 END AS has_ssh_key
       FROM provisioning_jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.id = ?`,
    )
    .get(id);
  if (claimed?.customer_id && (!claimed.repo_slug || !String(claimed.repo_slug).trim())) {
    claimed.repo_slug = ensureCustomerRepoSlug(database, claimed.customer_id);
  }
  return claimed;
}

export function completeProvisioningJob(id, { notes, resultJson } = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  const row = database.prepare(`SELECT * FROM provisioning_jobs WHERE id = ?`).get(id);
  if (!row) return null;
  if (row.status !== "claimed") return null;

  let payloadJson = row.payload_json;
  if (resultJson !== undefined) {
    let payload = {};
    if (payloadJson) {
      try {
        payload = JSON.parse(payloadJson) || {};
      } catch {
        payload = { _raw: payloadJson };
      }
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      payload = { _raw: payload };
    }
    payload.result = resultJson;
    payloadJson = JSON.stringify(payload);
  }

  const nextNotes = notes !== undefined ? notes : row.notes;
  database
    .prepare(
      `UPDATE provisioning_jobs SET
         status = 'done',
         notes = ?,
         payload_json = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(nextNotes ?? null, payloadJson, now, id);

  return database
    .prepare(
      `SELECT j.*,
              c.email AS email,
              c.stripe_customer_id AS stripe_customer_id,
              c.neo_ssh_public_key AS neo_ssh_public_key,
              c.gitea_deploy_key_id AS gitea_deploy_key_id,
              c.repo_slug AS repo_slug,
              CASE WHEN c.neo_ssh_public_key IS NOT NULL AND TRIM(c.neo_ssh_public_key) != '' THEN 1 ELSE 0 END AS has_ssh_key
       FROM provisioning_jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.id = ?`,
    )
    .get(id);
}

export function failProvisioningJob(id, { notes } = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  const row = database.prepare(`SELECT * FROM provisioning_jobs WHERE id = ?`).get(id);
  if (!row) return null;
  if (row.status !== "claimed") return null;

  const nextNotes = notes !== undefined ? notes : row.notes;
  database
    .prepare(
      `UPDATE provisioning_jobs SET status = 'failed', notes = ?, updated_at = ? WHERE id = ?`,
    )
    .run(nextNotes ?? null, now, id);

  return database
    .prepare(
      `SELECT j.*,
              c.email AS email,
              c.stripe_customer_id AS stripe_customer_id,
              c.neo_ssh_public_key AS neo_ssh_public_key,
              c.gitea_deploy_key_id AS gitea_deploy_key_id,
              c.repo_slug AS repo_slug,
              CASE WHEN c.neo_ssh_public_key IS NOT NULL AND TRIM(c.neo_ssh_public_key) != '' THEN 1 ELSE 0 END AS has_ssh_key
       FROM provisioning_jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.id = ?`,
    )
    .get(id);
}
