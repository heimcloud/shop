/**
 * Admin UI + /api/admin — browse/edit customers, orders, entitlements, jobs.
 * Edge auth: Tinyauth via SWAG (admin.auth). In-app: ADMIN_ENABLED / ADMIN_READ_ONLY.
 */
import { Router } from "express";
import { adminLayout, escapeHtml } from "./layout.js";
import {
  getDb,
  updateCustomerEmail,
  updateCustomerSshKey,
  updateCustomerGiteaDeployKeyId,
  updateProvisioningJob,
  updateEntitlementStatus,
} from "./db.js";

const ADMIN_ENABLED = !["false", "0", "no", "off"].includes(
  String(process.env.ADMIN_ENABLED ?? "true").toLowerCase(),
);
const ADMIN_PATH = (process.env.ADMIN_PATH || "/admin").replace(/\/$/, "") || "/admin";
const ADMIN_READ_ONLY = ["true", "1", "yes", "on"].includes(
  String(process.env.ADMIN_READ_ONLY || "false").toLowerCase(),
);

function stripeDashboardBase(secretKey) {
  const key = secretKey || process.env.STRIPE_SECRET_KEY || "";
  if (key.startsWith("sk_live")) return "https://dashboard.stripe.com";
  return "https://dashboard.stripe.com/test";
}

function customerDashUrl(stripeCustomerId, secretKey) {
  if (!stripeCustomerId) return null;
  return `${stripeDashboardBase(secretKey)}/customers/${encodeURIComponent(stripeCustomerId)}`;
}

function subscriptionDashUrl(stripeSubscriptionId, secretKey) {
  if (!stripeSubscriptionId) return null;
  return `${stripeDashboardBase(secretKey)}/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`;
}

function flash(q) {
  const msg = q && q.msg ? String(q.msg) : "";
  const err = q && q.err ? String(q.err) : "";
  if (err) return `<div class="alert warn">${escapeHtml(err)}</div>`;
  if (msg) return `<div class="alert ok">${escapeHtml(msg)}</div>`;
  return "";
}

function readOnlyBanner() {
  if (!ADMIN_READ_ONLY) return "";
  return `<div class="alert warn"><strong>Read-only.</strong> Mutating actions are disabled (ADMIN_READ_ONLY).</div>`;
}

function stripeMissingBanner(paymentsConfigured) {
  if (paymentsConfigured) return "";
  return `<div class="alert warn"><strong>Stripe not configured.</strong> Set <code>STRIPE_SECRET_KEY</code> to cancel subscriptions via API. Dashboard links still work when IDs are present.</div>`;
}

function table(headers, rowsHtml) {
  return `<div class="card" style="overflow-x:auto">
    <table class="admin-table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="${headers.length}" class="muted">None</td></tr>`}</tbody>
    </table>
  </div>`;
}

function refuseMutations(res, base) {
  if (ADMIN_READ_ONLY) {
    res.status(403).type("html").send(
      adminLayout({
        title: "Read-only",
        basePath: base,
        readOnly: true,
        body: `${readOnlyBanner()}<p><a href="${base}/">Back</a></p>`,
      }),
    );
    return true;
  }
  return false;
}

/**
 * @param {{ stripe: import('stripe').default | null, paymentsConfigured: boolean }} opts
 */
export function createAdminRouter({ stripe, paymentsConfigured }) {
  const router = Router();

  router.use((req, res, next) => {
    if (!ADMIN_ENABLED) {
      return res.status(404).type("html").send("Not found");
    }
    // Mount base for relative links (ADMIN_PATH or /api/admin)
    const mount = req.baseUrl || ADMIN_PATH;
    req.adminBase = mount.replace(/\/$/, "") || ADMIN_PATH;
    next();
  });

  router.get("/", (req, res) => {
    const db = getDb();
    const counts = {
      customers: db.prepare(`SELECT COUNT(*) AS n FROM customers`).get().n,
      orders: db.prepare(`SELECT COUNT(*) AS n FROM orders`).get().n,
      entitlementsActive: db
        .prepare(
          `SELECT COUNT(*) AS n FROM entitlements WHERE status IN ('active', 'trialing', 'past_due')`,
        )
        .get().n,
      jobsPending: db
        .prepare(`SELECT COUNT(*) AS n FROM provisioning_jobs WHERE status = 'pending'`)
        .get().n,
    };
    const recentOrders = db
      .prepare(
        `SELECT o.*, c.email AS customer_email
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
         ORDER BY o.id DESC LIMIT 10`,
      )
      .all();
    const recentWebhooks = db
      .prepare(`SELECT * FROM webhook_events ORDER BY id DESC LIMIT 10`)
      .all();
    const pendingJobs = db
      .prepare(
        `SELECT j.*, c.email AS customer_email
         FROM provisioning_jobs j LEFT JOIN customers c ON c.id = j.customer_id
         WHERE j.status = 'pending'
         ORDER BY j.id DESC LIMIT 10`,
      )
      .all();

    const base = req.adminBase;
    const orderRows = recentOrders
      .map(
        (o) => `<tr>
        <td><a href="${base}/orders/${o.id}">#${o.id}</a></td>
        <td>${escapeHtml(o.customer_email || "")}</td>
        <td>${escapeHtml(o.status || "")}</td>
        <td>${escapeHtml(o.mode || "")}</td>
        <td class="muted">${escapeHtml(o.created_at || "")}</td>
      </tr>`,
      )
      .join("");
    const whRows = recentWebhooks
      .map(
        (e) => `<tr>
        <td class="muted">${e.id}</td>
        <td><code>${escapeHtml(e.type)}</code></td>
        <td class="muted"><code>${escapeHtml(e.stripe_event_id)}</code></td>
        <td class="muted">${escapeHtml(e.processed_at || "")}</td>
      </tr>`,
      )
      .join("");
    const jobRows = pendingJobs
      .map(
        (j) => `<tr>
        <td><a href="${base}/jobs#job-${j.id}">#${j.id}</a></td>
        <td>${escapeHtml(j.job_type)}</td>
        <td>${escapeHtml(j.customer_email || "")}</td>
        <td class="muted">${escapeHtml(j.created_at || "")}</td>
      </tr>`,
      )
      .join("");

    res.type("html").send(
      adminLayout({
        title: "Overview",
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        body: `
        <h1>Admin overview</h1>
        ${readOnlyBanner()}
        ${stripeMissingBanner(paymentsConfigured)}
        ${flash(req.query)}
        <div class="grid grid-2">
          <div class="card"><p class="muted">Customers</p><p class="price" style="font-size:1.6rem">${counts.customers}</p></div>
          <div class="card"><p class="muted">Orders</p><p class="price" style="font-size:1.6rem">${counts.orders}</p></div>
          <div class="card"><p class="muted">Active entitlements</p><p class="price" style="font-size:1.6rem">${counts.entitlementsActive}</p></div>
          <div class="card"><p class="muted">Pending jobs</p><p class="price" style="font-size:1.6rem">${counts.jobsPending}</p></div>
        </div>
        <h2>Recent orders</h2>
        ${table(["ID", "Customer", "Status", "Mode", "Created"], orderRows)}
        <h2>Recent webhook events</h2>
        ${table(["ID", "Type", "Event", "Processed"], whRows)}
        <h2>Pending provisioning jobs</h2>
        ${table(["ID", "Type", "Customer", "Created"], jobRows)}
        `,
      }),
    );
  });

  router.get("/customers", (req, res) => {
    const db = getDb();
    const q = String(req.query.q || "").trim();
    const rows = q
      ? db
          .prepare(
            `SELECT * FROM customers WHERE email LIKE ? ORDER BY id DESC LIMIT 100`,
          )
          .all(`%${q}%`)
      : db.prepare(`SELECT * FROM customers ORDER BY id DESC LIMIT 100`).all();
    const base = req.adminBase;
    const bodyRows = rows
      .map(
        (c) => `<tr>
        <td><a href="${base}/customers/${c.id}">#${c.id}</a></td>
        <td>${escapeHtml(c.email)}</td>
        <td class="muted"><code>${escapeHtml(c.stripe_customer_id || "—")}</code></td>
        <td class="muted">${escapeHtml(c.created_at || "")}</td>
      </tr>`,
      )
      .join("");
    res.type("html").send(
      adminLayout({
        title: "Customers",
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        body: `
        <h1>Customers</h1>
        ${flash(req.query)}
        <form class="card" method="get" action="${base}/customers">
          <label>Search email</label>
          <input name="q" value="${escapeHtml(q)}" placeholder="email@" />
          <p style="margin-top:1rem"><button class="btn" type="submit">Search</button>
          ${q ? `<a class="btn secondary" href="${base}/customers">Clear</a>` : ""}</p>
        </form>
        ${table(["ID", "Email", "Stripe customer", "Created"], bodyRows)}
        `,
      }),
    );
  });

  router.get("/customers/:id", (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const c = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
    if (!c) return res.status(404).send("Not found");
    const base = req.adminBase;
    const orders = db
      .prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 50`)
      .all(id);
    const ents = db
      .prepare(`SELECT * FROM entitlements WHERE customer_id = ? ORDER BY id DESC`)
      .all(id);
    const dash = customerDashUrl(c.stripe_customer_id);
    const orderRows = orders
      .map(
        (o) =>
          `<tr><td><a href="${base}/orders/${o.id}">#${o.id}</a></td><td>${escapeHtml(o.status || "")}</td><td class="muted">${escapeHtml(o.created_at || "")}</td></tr>`,
      )
      .join("");
    const entRows = ents
      .map(
        (e) =>
          `<tr><td>${escapeHtml(e.service_id)}</td><td>${escapeHtml(e.status || "")}</td><td class="muted"><code>${escapeHtml(e.stripe_subscription_id || "—")}</code></td></tr>`,
      )
      .join("");

    const hasSshKey = Boolean(c.neo_ssh_public_key && String(c.neo_ssh_public_key).trim());
    const editForm = ADMIN_READ_ONLY
      ? `<p class="muted">Email edit disabled (read-only).</p>`
      : `<form method="post" action="${base}/customers/${c.id}">
          <input type="hidden" name="_action" value="email" />
          <label>Email</label>
          <input type="email" name="email" required value="${escapeHtml(c.email)}" />
          <p style="margin-top:1rem"><button class="btn" type="submit">Save email</button></p>
        </form>`;

    const sshForm = ADMIN_READ_ONLY
      ? `<p class="muted">SSH key edit disabled (read-only).</p>
         <p><strong>Neo SSH public key:</strong> ${hasSshKey ? "set" : "not set"}</p>
         ${hasSshKey ? `<pre style="white-space:pre-wrap;font-size:0.8rem;overflow-x:auto">${escapeHtml(c.neo_ssh_public_key)}</pre>` : ""}
         <p class="muted"><strong>Gitea deploy key id:</strong> <code>${escapeHtml(c.gitea_deploy_key_id || "—")}</code></p>`
      : `<form method="post" action="${base}/customers/${c.id}">
          <input type="hidden" name="_action" value="ssh_key" />
          <p><strong>Neo SSH public key:</strong> ${hasSshKey ? '<span class="ok">set</span>' : '<span class="muted">not set</span>'}</p>
          <label>Public key (ssh-ed25519 / ssh-rsa / ecdsa- / sk-…). Leave empty and save to clear.</label>
          <textarea name="neo_ssh_public_key" rows="3" placeholder="ssh-ed25519 AAAA… comment">${escapeHtml(c.neo_ssh_public_key || "")}</textarea>
          <label>Gitea deploy key id (optional, set by Credentials after attach)</label>
          <input name="gitea_deploy_key_id" value="${escapeHtml(c.gitea_deploy_key_id || "")}" placeholder="e.g. 42" />
          <p style="margin-top:1rem">
            <button class="btn" type="submit">Save SSH key</button>
            ${hasSshKey ? `<button class="btn secondary" type="submit" name="clear_ssh_key" value="1">Clear key</button>` : ""}
          </p>
        </form>`;

    res.type("html").send(
      adminLayout({
        title: `Customer #${c.id}`,
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        body: `
        <h1>Customer #${c.id}</h1>
        ${readOnlyBanner()}
        ${flash(req.query)}
        <div class="card">
          <p><strong>Email:</strong> ${escapeHtml(c.email)}</p>
          <p><strong>Stripe customer:</strong> <code>${escapeHtml(c.stripe_customer_id || "—")}</code>
            ${dash ? ` · <a href="${dash}" target="_blank" rel="noopener">Stripe Dashboard</a>` : ""}</p>
          <p><strong>repo_slug:</strong> <code>${escapeHtml(c.repo_slug || "—")}</code>
            · <strong>SSH key:</strong> ${hasSshKey ? "set" : "not set"}
            · <strong>Gitea deploy key id:</strong> <code>${escapeHtml(c.gitea_deploy_key_id || "—")}</code></p>
          <p class="muted">Created ${escapeHtml(c.created_at || "")} · Updated ${escapeHtml(c.updated_at || "")}</p>
          ${editForm}
        </div>
        <div class="card">
          <h2>Neo SSH / Gitea deploy key</h2>
          <p class="muted">Shop only stores the key for Credentials — does not change repo visibility.</p>
          ${sshForm}
        </div>
        <h2>Orders</h2>
        ${table(["ID", "Status", "Created"], orderRows)}
        <h2>Entitlements</h2>
        ${table(["Service", "Status", "Subscription"], entRows)}
        <p><a href="${base}/customers">← Customers</a></p>
        `,
      }),
    );
  });

  router.post("/customers/:id", (req, res) => {
    const base = req.adminBase;
    if (refuseMutations(res, base)) return;
    const id = Number(req.params.id);
    const action = String(req.body._action || "email").trim();

    if (action === "ssh_key") {
      try {
        const clear = String(req.body.clear_ssh_key || "") === "1";
        const rawKey = clear ? "" : String(req.body.neo_ssh_public_key || "").trim();
        if (!clear && rawKey) {
          const okPrefix =
            rawKey.startsWith("ssh-ed25519 ") ||
            rawKey.startsWith("ssh-rsa ") ||
            rawKey.startsWith("ecdsa-") ||
            rawKey.startsWith("sk-");
          if (!okPrefix || rawKey.split(/\s+/).length < 2) {
            return res.redirect(
              303,
              `${base}/customers/${id}?err=${encodeURIComponent("Invalid SSH public key")}`,
            );
          }
        }
        const updated = updateCustomerSshKey(id, clear || !rawKey ? null : rawKey);
        if (!updated) return res.status(404).send("Not found");

        if (Object.prototype.hasOwnProperty.call(req.body, "gitea_deploy_key_id")) {
          const gid = String(req.body.gitea_deploy_key_id || "").trim();
          updateCustomerGiteaDeployKeyId(id, gid || null);
        }

        const msg = clear || !rawKey ? "SSH key cleared" : "SSH key updated";
        return res.redirect(303, `${base}/customers/${id}?msg=${encodeURIComponent(msg)}`);
      } catch (err) {
        console.error("[admin] ssh key update", err);
        return res.redirect(
          303,
          `${base}/customers/${id}?err=${encodeURIComponent(err.message || "SSH key update failed")}`,
        );
      }
    }

    const email = String(req.body.email || "").trim();
    if (!email) {
      return res.redirect(303, `${base}/customers/${id}?err=${encodeURIComponent("Email required")}`);
    }
    try {
      updateCustomerEmail(id, email);
      return res.redirect(303, `${base}/customers/${id}?msg=${encodeURIComponent("Email updated")}`);
    } catch (err) {
      console.error("[admin] customer update", err);
      return res.redirect(
        303,
        `${base}/customers/${id}?err=${encodeURIComponent(err.message || "Update failed")}`,
      );
    }
  });

  router.get("/orders", (req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT o.*, c.email AS customer_email
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
         ORDER BY o.id DESC LIMIT 100`,
      )
      .all();
    const base = req.adminBase;
    const bodyRows = rows
      .map(
        (o) => `<tr>
        <td><a href="${base}/orders/${o.id}">#${o.id}</a></td>
        <td>${escapeHtml(o.customer_email || "")}</td>
        <td>${escapeHtml(o.status || "")}</td>
        <td>${escapeHtml(o.mode || "")}</td>
        <td class="muted"><code>${escapeHtml(o.stripe_session_id || "—")}</code></td>
        <td class="muted">${escapeHtml(o.created_at || "")}</td>
      </tr>`,
      )
      .join("");
    res.type("html").send(
      adminLayout({
        title: "Orders",
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        body: `
        <h1>Orders</h1>
        ${table(["ID", "Customer", "Status", "Mode", "Session", "Created"], bodyRows)}
        `,
      }),
    );
  });

  router.get("/orders/:id", (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const o = db
      .prepare(
        `SELECT o.*, c.email AS customer_email, c.stripe_customer_id
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
         WHERE o.id = ?`,
      )
      .get(id);
    if (!o) return res.status(404).send("Not found");
    const base = req.adminBase;
    let kitPretty = o.kit_config_json || "—";
    let linesPretty = o.line_items_json || "—";
    try {
      if (o.kit_config_json) kitPretty = JSON.stringify(JSON.parse(o.kit_config_json), null, 2);
    } catch {
      /* keep raw */
    }
    try {
      if (o.line_items_json) linesPretty = JSON.stringify(JSON.parse(o.line_items_json), null, 2);
    } catch {
      /* keep raw */
    }
    res.type("html").send(
      adminLayout({
        title: `Order #${o.id}`,
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        body: `
        <h1>Order #${o.id}</h1>
        <div class="card">
          <p><strong>Customer:</strong> <a href="${base}/customers/${o.customer_id}">${escapeHtml(o.customer_email || `#${o.customer_id}`)}</a></p>
          <p><strong>Status:</strong> ${escapeHtml(o.status || "—")}</p>
          <p><strong>Mode:</strong> ${escapeHtml(o.mode || "—")}</p>
          <p><strong>Amount:</strong> ${o.amount_total != null ? `${o.amount_total} ${escapeHtml(o.currency || "")}` : "—"}</p>
          <p><strong>Stripe session:</strong> <code>${escapeHtml(o.stripe_session_id || "—")}</code></p>
          <p class="muted">Created ${escapeHtml(o.created_at || "")}</p>
        </div>
        <div class="card">
          <h2>kit_config</h2>
          <pre style="white-space:pre-wrap;font-size:0.85rem">${escapeHtml(kitPretty)}</pre>
        </div>
        <div class="card">
          <h2>line_items</h2>
          <pre style="white-space:pre-wrap;font-size:0.85rem">${escapeHtml(linesPretty)}</pre>
        </div>
        <p><a href="${base}/orders">← Orders</a></p>
        `,
      }),
    );
  });

  router.get("/entitlements", (req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT e.*, c.email AS customer_email
         FROM entitlements e LEFT JOIN customers c ON c.id = e.customer_id
         ORDER BY e.id DESC LIMIT 200`,
      )
      .all();
    const base = req.adminBase;
    const bodyRows = rows
      .map((e) => {
        const subUrl = subscriptionDashUrl(e.stripe_subscription_id);
        const canCancel = Boolean(e.stripe_subscription_id);
        const actions =
          !canCancel || ADMIN_READ_ONLY
            ? `<span class="muted">${ADMIN_READ_ONLY ? "read-only" : "no sub"}</span>`
            : `<form method="post" action="${base}/entitlements/${e.id}/cancel-at-period-end" style="display:inline" onsubmit="return confirm('Cancel at period end?');">
                <button class="btn secondary" type="submit" ${paymentsConfigured ? "" : "disabled"}>Cancel at period end</button>
              </form>
              <form method="post" action="${base}/entitlements/${e.id}/cancel-now" style="display:inline;margin-left:0.35rem" onsubmit="return confirm('Cancel immediately?');">
                <button class="btn secondary" type="submit" ${paymentsConfigured ? "" : "disabled"}>Cancel now</button>
              </form>`;
        return `<tr>
          <td>#${e.id}</td>
          <td><a href="${base}/customers/${e.customer_id}">${escapeHtml(e.customer_email || "")}</a></td>
          <td>${escapeHtml(e.service_id)}</td>
          <td>${escapeHtml(e.status || "")}</td>
          <td class="muted">${escapeHtml(e.current_period_end || "—")}</td>
          <td class="muted"><code>${escapeHtml(e.stripe_subscription_id || "—")}</code>
            ${subUrl ? `<br/><a href="${subUrl}" target="_blank" rel="noopener">Dashboard</a>` : ""}</td>
          <td>${actions}</td>
        </tr>`;
      })
      .join("");
    res.type("html").send(
      adminLayout({
        title: "Entitlements",
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        body: `
        <h1>Entitlements</h1>
        ${readOnlyBanner()}
        ${stripeMissingBanner(paymentsConfigured)}
        ${flash(req.query)}
        ${table(
          ["ID", "Customer", "Service", "Status", "Period end", "Subscription", "Actions"],
          bodyRows,
        )}
        `,
      }),
    );
  });

  async function cancelEntitlement(req, res, mode) {
    const base = req.adminBase;
    if (refuseMutations(res, base)) return;
    const id = Number(req.params.id);
    const db = getDb();
    const e = db.prepare(`SELECT * FROM entitlements WHERE id = ?`).get(id);
    if (!e) return res.status(404).send("Not found");
    if (!e.stripe_subscription_id) {
      return res.redirect(
        303,
        `${base}/entitlements?err=${encodeURIComponent("No Stripe subscription on entitlement")}`,
      );
    }
    if (!paymentsConfigured || !stripe) {
      return res.redirect(
        303,
        `${base}/entitlements?err=${encodeURIComponent("STRIPE_SECRET_KEY not set")}`,
      );
    }
    try {
      if (mode === "period_end") {
        const sub = await stripe.subscriptions.update(e.stripe_subscription_id, {
          cancel_at_period_end: true,
        });
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : e.current_period_end;
        updateEntitlementStatus(id, sub.status || e.status, periodEnd);
        return res.redirect(
          303,
          `${base}/entitlements?msg=${encodeURIComponent(`Subscription ${e.stripe_subscription_id} set to cancel at period end`)}`,
        );
      }
      const sub = await stripe.subscriptions.cancel(e.stripe_subscription_id);
      updateEntitlementStatus(id, sub.status || "canceled", e.current_period_end);
      return res.redirect(
        303,
        `${base}/entitlements?msg=${encodeURIComponent(`Subscription ${e.stripe_subscription_id} canceled immediately`)}`,
      );
    } catch (err) {
      console.error("[admin] cancel subscription", err);
      return res.redirect(
        303,
        `${base}/entitlements?err=${encodeURIComponent(err.message || "Stripe cancel failed")}`,
      );
    }
  }

  router.post("/entitlements/:id/cancel-at-period-end", (req, res) =>
    cancelEntitlement(req, res, "period_end"),
  );
  router.post("/entitlements/:id/cancel-now", (req, res) => cancelEntitlement(req, res, "now"));

  router.get("/jobs", (req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT j.*, c.email AS customer_email
         FROM provisioning_jobs j LEFT JOIN customers c ON c.id = j.customer_id
         ORDER BY j.id DESC LIMIT 200`,
      )
      .all();
    const base = req.adminBase;
    const bodyRows = rows
      .map((j) => {
        const form = ADMIN_READ_ONLY
          ? `<span class="muted">read-only</span>`
          : `<form method="post" action="${base}/jobs/${j.id}" id="job-${j.id}">
              <select name="status">
                ${["pending", "claimed", "done", "failed"]
                  .map(
                    (s) =>
                      `<option value="${s}" ${j.status === s ? "selected" : ""}>${s}</option>`,
                  )
                  .join("")}
              </select>
              <input name="notes" value="${escapeHtml(j.notes || "")}" placeholder="notes" />
              <button class="btn secondary" type="submit">Save</button>
            </form>`;
        return `<tr id="job-${j.id}">
          <td>#${j.id}</td>
          <td>${escapeHtml(j.job_type)}</td>
          <td><a href="${base}/customers/${j.customer_id}">${escapeHtml(j.customer_email || "")}</a></td>
          <td>${escapeHtml(j.status)}</td>
          <td class="muted">${escapeHtml(j.notes || "—")}</td>
          <td class="muted">${escapeHtml(j.created_at || "")}</td>
          <td>${form}</td>
        </tr>`;
      })
      .join("");
    res.type("html").send(
      adminLayout({
        title: "Jobs",
        basePath: base,
        readOnly: ADMIN_READ_ONLY,
        body: `
        <h1>Provisioning jobs</h1>
        ${readOnlyBanner()}
        ${flash(req.query)}
        ${table(
          ["ID", "Type", "Customer", "Status", "Notes", "Created", "Update"],
          bodyRows,
        )}
        `,
      }),
    );
  });

  router.post("/jobs/:id", (req, res) => {
    const base = req.adminBase;
    if (refuseMutations(res, base)) return;
    const id = Number(req.params.id);
    const status = String(req.body.status || "").trim();
    const notes = req.body.notes != null ? String(req.body.notes) : undefined;
    if (!["pending", "claimed", "done", "failed"].includes(status)) {
      return res.redirect(
        303,
        `${base}/jobs?err=${encodeURIComponent("Invalid status")}`,
      );
    }
    const updated = updateProvisioningJob(id, { status, notes });
    if (!updated) return res.status(404).send("Not found");
    return res.redirect(303, `${base}/jobs?msg=${encodeURIComponent(`Job #${id} updated`)}`);
  });

  return router;
}

export function getAdminConfig() {
  return { ADMIN_ENABLED, ADMIN_PATH, ADMIN_READ_ONLY };
}
