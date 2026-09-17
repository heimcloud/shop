/**
 * SQLite (better-sqlite3) with WAL + foreign keys.
 * Path: SHOP_DB_PATH (default /data/shop.sqlite).
 */
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
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

  if (!columnExists(database, "customers", "display_name")) {
    database.exec(`ALTER TABLE customers ADD COLUMN display_name TEXT`);
  }

  if (!columnExists(database, "customers", "machine_label")) {
    database.exec(`ALTER TABLE customers ADD COLUMN machine_label TEXT`);
  }

  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_repo_slug ON customers(repo_slug) WHERE repo_slug IS NOT NULL`,
  );

  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_machine_label ON customers(machine_label) WHERE machine_label IS NOT NULL AND TRIM(machine_label) != ''`,
  );

  // Backfill opaque Crockford slugs for existing customers
  const missing = database
    .prepare(`SELECT id FROM customers WHERE repo_slug IS NULL OR TRIM(repo_slug) = ''`)
    .all();
  for (const row of missing) {
    ensureCustomerRepoSlug(database, row.id);
  }

  if (!columnExists(database, "customers", "auth_subject")) {
    database.exec(`ALTER TABLE customers ADD COLUMN auth_subject TEXT`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS magic_link_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      request_ip TEXT
    );
  `);

  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_customer ON magic_link_tokens(customer_id)`,
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS magic_link_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id),
      email TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      request_ip TEXT
    );
  `);

  seedLabCustomers(database);

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

/**
 * Idempotent lab customer seeds (hattori / thatch) with fixed Credentials repo_slugs.
 * Called from migrate — forces exact slug; clears conflicting holders first.
 */
export function seedLabCustomers(database) {
  const labs = [
    {
      email: "hattori@heimcloud.site",
      display_name: "hattori",
      machine_label: "hattori",
      repo_slug: "KAKJWG9RM5",
    },
    {
      email: "thatch@heimcloud.site",
      display_name: "thatch",
      machine_label: "thatch",
      repo_slug: "W4ZGSG7SYJ",
    },
  ];
  const now = new Date().toISOString();
  for (const lab of labs) {
    const byEmail = database
      .prepare(`SELECT * FROM customers WHERE email = ?`)
      .get(lab.email);
    const bySlug = database
      .prepare(`SELECT * FROM customers WHERE repo_slug = ?`)
      .get(lab.repo_slug);

    if (bySlug && (!byEmail || bySlug.id !== byEmail.id)) {
      database
        .prepare(
          `UPDATE customers SET repo_slug = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, bySlug.id);
    }

    if (byEmail) {
      database
        .prepare(
          `UPDATE customers SET
            display_name = ?,
            machine_label = ?,
            repo_slug = ?,
            updated_at = ?
          WHERE id = ?`,
        )
        .run(lab.display_name, lab.machine_label, lab.repo_slug, now, byEmail.id);
    } else {
      try {
        database
          .prepare(
            `INSERT INTO customers (
              email, stripe_customer_id, display_name, machine_label, repo_slug,
              created_at, updated_at
            ) VALUES (?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            lab.email,
            lab.display_name,
            lab.machine_label,
            lab.repo_slug,
            now,
            now,
          );
      } catch (err) {
        // Race / unique: re-fetch by email and force fields
        if (!String(err.message || "").includes("UNIQUE")) throw err;
        const again = database
          .prepare(`SELECT * FROM customers WHERE email = ?`)
          .get(lab.email);
        if (again) {
          database
            .prepare(
              `UPDATE customers SET
                display_name = ?,
                machine_label = ?,
                repo_slug = ?,
                updated_at = ?
              WHERE id = ?`,
            )
            .run(
              lab.display_name,
              lab.machine_label,
              lab.repo_slug,
              now,
              again.id,
            );
        } else {
          throw err;
        }
      }
    }
  }
}

/**
 * Update customer profile fields (only provided keys).
 * @returns {null|object}
 */
export function updateCustomerProfile(id, { email, display_name, machine_label } = {}) {
  const database = getDb();
  const row = database.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
  if (!row) return null;
  const now = new Date().toISOString();
  const nextEmail = email !== undefined ? String(email).trim() : row.email;
  const nextDisplay =
    display_name !== undefined
      ? display_name == null || String(display_name).trim() === ""
        ? null
        : String(display_name).trim()
      : row.display_name;
  const nextLabel =
    machine_label !== undefined
      ? machine_label == null || String(machine_label).trim() === ""
        ? null
        : String(machine_label).trim()
      : row.machine_label;
  database
    .prepare(
      `UPDATE customers SET
        email = ?,
        display_name = ?,
        machine_label = ?,
        updated_at = ?
      WHERE id = ?`,
    )
    .run(nextEmail, nextDisplay, nextLabel, now, id);
  return database.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
}

/**
 * Ensure a stub ensure_config_overlay provisioning job exists for this service.
 * Dedupes on pending/claimed/done with matching service_id in payload.
 */
export function ensureConfigOverlayJob({ customerId, serviceId, stripeSubscriptionId }) {
  const database = getDb();
  if (!customerId || !serviceId) return null;

  const customer = database.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  if (!customer) return null;
  const repoSlug = ensureCustomerRepoSlug(database, customerId);

  const candidates = database
    .prepare(
      `SELECT * FROM provisioning_jobs
       WHERE customer_id = ?
         AND job_type = 'ensure_config_overlay'
         AND status IN ('pending', 'claimed', 'done')
       ORDER BY id DESC`,
    )
    .all(customerId);

  for (const job of candidates) {
    let payload = {};
    if (job.payload_json) {
      try {
        payload = JSON.parse(job.payload_json) || {};
      } catch {
        // fallback: substring match
        if (
          String(job.payload_json).includes(`"service_id":"${serviceId}"`) ||
          String(job.payload_json).includes(`"service_id": "${serviceId}"`)
        ) {
          return job;
        }
        continue;
      }
    }
    if (payload.service_id === serviceId) return job;
  }

  const fresh = database.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  const payloadJson = JSON.stringify({
    model: "config-overlay",
    service_id: serviceId,
    customer_id: customerId,
    repo_slug: repoSlug || fresh?.repo_slug || null,
    email: fresh?.email || null,
    machine_label: fresh?.machine_label || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    note: "Stub — Credentials creates overlay folder layout",
  });

  return insertProvisioningJob({
    customerId,
    orderId: null,
    jobType: "ensure_config_overlay",
    payloadJson,
    status: "pending",
  });
}

/** Active entitlement statuses used for overview / mismatch checks. */
const ACTIVE_ENT_STATUSES = ["active", "trialing", "past_due"];

/**
 * Customer overview helpers: active entitlements count + mismatch flags.
 */
export function getCustomerOverview(customerId) {
  const database = getDb();
  const customer = database.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  if (!customer) return null;

  const entitlements = database
    .prepare(`SELECT * FROM entitlements WHERE customer_id = ? ORDER BY id DESC`)
    .all(customerId);
  const activeEnts = entitlements.filter((e) =>
    ACTIVE_ENT_STATUSES.includes(String(e.status || "").toLowerCase()),
  );
  const jobs = database
    .prepare(
      `SELECT * FROM provisioning_jobs WHERE customer_id = ? ORDER BY id DESC LIMIT 100`,
    )
    .all(customerId);

  const hasSsh = Boolean(
    customer.neo_ssh_public_key && String(customer.neo_ssh_public_key).trim(),
  );
  const hasDeployKey = Boolean(
    customer.gitea_deploy_key_id && String(customer.gitea_deploy_key_id).trim(),
  );
  const hasRepo = Boolean(customer.repo_slug && String(customer.repo_slug).trim());

  const overlayJobs = jobs.filter((j) => j.job_type === "ensure_config_overlay");
  const missingOverlay = [];
  for (const ent of activeEnts) {
    const sid = ent.service_id;
    const found = overlayJobs.some((j) => {
      if (!["pending", "claimed", "done"].includes(j.status)) return false;
      if (!j.payload_json) return false;
      try {
        const p = JSON.parse(j.payload_json);
        return p && p.service_id === sid;
      } catch {
        return (
          String(j.payload_json).includes(`"service_id":"${sid}"`) ||
          String(j.payload_json).includes(`"service_id": "${sid}"`)
        );
      }
    });
    if (!found) missingOverlay.push(sid);
  }

  const mismatches = {
    active_without_overlay_job: missingOverlay,
    ssh_without_gitea_deploy_key: hasSsh && !hasDeployKey,
    repo_without_ssh: hasRepo && !hasSsh,
  };

  return {
    customer,
    entitlements,
    active_entitlements_count: activeEnts.length,
    jobs,
    has_ssh_key: hasSsh,
    mismatches,
  };
}

export function countActiveEntitlements(customerId) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM entitlements
       WHERE customer_id = ? AND status IN ('active', 'trialing', 'past_due')`,
    )
    .get(customerId).n;
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
              c.display_name AS display_name,
              c.machine_label AS machine_label,
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
              c.display_name AS display_name,
              c.machine_label AS machine_label,
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
              c.display_name AS display_name,
              c.machine_label AS machine_label,
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
              c.display_name AS display_name,
              c.machine_label AS machine_label,
              CASE WHEN c.neo_ssh_public_key IS NOT NULL AND TRIM(c.neo_ssh_public_key) != '' THEN 1 ELSE 0 END AS has_ssh_key
       FROM provisioning_jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE j.id = ?`,
    )
    .get(id);
}


function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/**
 * Create a single-use magic-link token for a customer.
 * Returns the raw token once; only the sha256 hex hash is stored.
 * @param {number} customerId
 * @param {{ ttlSeconds?: number, ip?: string|null }} [opts]
 * @returns {string} raw token
 */
export function createMagicLinkToken(customerId, { ttlSeconds = 900, ip } = {}) {
  const database = getDb();
  const customer = database.prepare(`SELECT id FROM customers WHERE id = ?`).get(customerId);
  if (!customer) throw new Error("customer_not_found");

  const ttl = Math.min(Math.max(Number(ttlSeconds) || 900, 60), 3600);
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(raw);
  const now = new Date();
  const expires = new Date(now.getTime() + ttl * 1000).toISOString();
  const created = now.toISOString();

  database
    .prepare(
      `INSERT INTO magic_link_tokens (customer_id, token_hash, expires_at, created_at, request_ip)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(customerId, tokenHash, expires, created, ip || null);

  return raw;
}

/**
 * Consume a raw magic-link token: verify hash, unused, unexpired; mark used.
 * @returns {object|null} customer row or null
 */
export function consumeMagicLinkToken(rawToken) {
  const database = getDb();
  if (rawToken == null || String(rawToken).trim() === "") return null;
  const tokenHash = sha256Hex(String(rawToken).trim());
  const row = database
    .prepare(`SELECT * FROM magic_link_tokens WHERE token_hash = ?`)
    .get(tokenHash);
  if (!row) return null;
  if (row.used_at) return null;
  const now = new Date();
  if (new Date(row.expires_at).getTime() <= now.getTime()) return null;

  const usedAt = now.toISOString();
  const info = database
    .prepare(
      `UPDATE magic_link_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`,
    )
    .run(usedAt, row.id);
  if (info.changes === 0) return null;

  return database.prepare(`SELECT * FROM customers WHERE id = ?`).get(row.customer_id) || null;
}

/**
 * Simple SQLite rate limit: >5 magic-link creates for same email or IP in last 15m → reject.
 * @param {string} emailOrIp
 * @returns {{ ok: boolean, count: number, reason?: string }}
 */
export function rateLimitMagicLink(emailOrIp) {
  const database = getDb();
  const key = String(emailOrIp || "").trim().toLowerCase();
  if (!key) return { ok: false, count: 0, reason: "missing_key" };

  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Match by request_ip OR customer email (join)
  const byIp = database
    .prepare(
      `SELECT COUNT(*) AS n FROM magic_link_tokens
       WHERE request_ip IS NOT NULL
         AND lower(request_ip) = ?
         AND created_at >= ?`,
    )
    .get(key, since).n;

  const byEmail = database
    .prepare(
      `SELECT COUNT(*) AS n FROM magic_link_tokens t
       JOIN customers c ON c.id = t.customer_id
       WHERE lower(c.email) = ?
         AND t.created_at >= ?`,
    )
    .get(key, since).n;

  const count = Math.max(byIp, byEmail);
  if (count >= 5) {
    return { ok: false, count, reason: "rate_limited" };
  }
  return { ok: true, count };
}

/**
 * Look up customer by email (case-insensitive trim).
 * @returns {object|null}
 */
export function getCustomerByEmail(email) {
  const database = getDb();
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  return database
    .prepare(`SELECT * FROM customers WHERE lower(email) = ?`)
    .get(normalized);
}

/**
 * Optional stub delivery log for magic links (dev console + DB).
 */
export function recordMagicLinkDelivery({ customerId, email, url, ip }) {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO magic_link_deliveries (customer_id, email, url, request_ip)
       VALUES (?, ?, ?, ?)`,
    )
    .run(customerId ?? null, String(email || ""), String(url || ""), ip || null);
}

/**
 * Enqueue Credentials job to attach RO Gitea deploy key.
 * Dedupes if pending/claimed already exists for this customer.
 * @returns {object|null} job row
 */
export function enqueueAttachDeployKeyJob(customerId) {
  const database = getDb();
  if (!customerId) return null;
  const customer = database.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  if (!customer) return null;

  const repoSlug = ensureCustomerRepoSlug(database, customerId);
  const fresh = database.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  const hasSsh = Boolean(
    fresh?.neo_ssh_public_key && String(fresh.neo_ssh_public_key).trim(),
  );

  const existing = database
    .prepare(
      `SELECT * FROM provisioning_jobs
       WHERE customer_id = ?
         AND job_type = 'attach_gitea_deploy_key'
         AND status IN ('pending', 'claimed')
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(customerId);
  if (existing) return existing;

  const pubkey =
    hasSsh && fresh?.neo_ssh_public_key
      ? String(fresh.neo_ssh_public_key).trim()
      : null;

  const payloadJson = JSON.stringify({
    customer_id: customerId,
    repo_slug: repoSlug || fresh?.repo_slug || null,
    email: fresh?.email || null,
    machine_label: fresh?.machine_label || null,
    has_ssh_key: hasSsh,
    pubkey,
    neo_ssh_public_key: pubkey,
    note: "Attach read-only Gitea deploy key for customer private repo",
  });

  return insertProvisioningJob({
    customerId,
    orderId: null,
    jobType: "attach_gitea_deploy_key",
    payloadJson,
    status: "pending",
  });
}
