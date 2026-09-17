/**
 * Customer account portal (Path S) — magic-link auth, separate from Tinyauth admin.
 * Cookie: shop_account_session (HMAC). Never asks for private keys.
 *
 * TODO(mail): replace console stub sendMagicLinkEmail with real SMTP / Mail provider.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { accountLayout, layout, escapeHtml } from "./layout.js";
import {
  getDb,
  getCustomerByEmail,
  getCustomerOverview,
  createMagicLinkToken,
  consumeMagicLinkToken,
  rateLimitMagicLink,
  recordMagicLinkDelivery,
  updateCustomerSshKey,
  enqueueAttachDeployKeyJob,
} from "./db.js";
import { isValidSshPublicKey, sshKeyFingerprintSha256 } from "./provisioning.js";

const COOKIE_NAME = "shop_account_session";
const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60; // ~7d
const MAGIC_TTL_SEC = 900; // 15m

function siteUrl() {
  const port = Number(process.env.PORT || 3000);
  return (process.env.SITE_URL || `http://localhost:${port}`).replace(/\/$/, "");
}

function sessionSecret() {
  const explicit =
    process.env.ACCOUNT_SESSION_SECRET ||
    process.env.SESSION_SECRET ||
    "";
  if (explicit.trim()) return explicit.trim();
  // Fallback derive from webhook secret (dev/ops convenience — prefer ACCOUNT_SESSION_SECRET)
  const wh = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (wh.trim()) return `account-session:${wh.trim()}`;
  return "dev-insecure-account-session-secret";
}

function cookieSecure() {
  return String(siteUrl()).toLowerCase().startsWith("https");
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64");
}

function signPayload(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = createHmac("sha256", sessionSecret()).update(payload).digest();
  return `${payload}.${b64url(sig)}`;
}

function verifySignedCookie(raw) {
  if (!raw || typeof raw !== "string" || !raw.includes(".")) return null;
  const [payload, sig] = raw.split(".", 2);
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest();
  let got;
  try {
    got = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload).toString("utf8"));
    if (!data || typeof data.customerId !== "number") return null;
    if (typeof data.exp !== "number" || data.exp * 1000 <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of String(header).split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setAccountSessionCookie(res, customerId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
  const value = signPayload({ customerId, exp });
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/account",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  if (cookieSecure()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAccountSessionCookie(res) {
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/account",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (cookieSecure()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

function flash(q) {
  const msg = q && q.msg ? String(q.msg) : "";
  const err = q && q.err ? String(q.err) : "";
  if (err) return `<div class="alert warn">${escapeHtml(err)}</div>`;
  if (msg) return `<div class="alert ok">${escapeHtml(msg)}</div>`;
  return "";
}

function fingerprintShort(publicKey) {
  const hex = sshKeyFingerprintSha256(publicKey);
  return hex.slice(-12);
}

/**
 * Console stub — logs magic link; also writes magic_link_deliveries.
 * TODO(mail): integrate real email (SMTP / Mail) — do not ship secrets in URL body to third parties carelessly.
 */
function sendMagicLinkEmail({ email, url, customerId, ip }) {
  console.log(`[magic-link] email=${email} url=${url}`);
  try {
    recordMagicLinkDelivery({ customerId, email, url, ip });
  } catch (err) {
    console.error("[magic-link] delivery log failed", err.message);
  }
}

export function requireAccountSession(req, res, next) {
  const cookies = parseCookies(req);
  const data = verifySignedCookie(cookies[COOKIE_NAME]);
  if (!data) {
    return res.redirect(303, "/account/login");
  }
  const row = getDb().prepare(`SELECT * FROM customers WHERE id = ?`).get(data.customerId);
  if (!row) {
    clearAccountSessionCookie(res);
    return res.redirect(303, "/account/login");
  }
  req.accountCustomer = row;
  return next();
}

export function createAccountRouter() {
  const router = Router();

  // --- Public login ---
  router.get("/login", (req, res) => {
    res.type("html").send(
      layout({
        title: "Account login",
        body: `
        <h1>Customer account</h1>
        <p class="muted">Sign in with a magic link sent to the email on your order. No password.</p>
        ${flash(req.query)}
        <form class="card" method="post" action="/account/login">
          <label>Email</label>
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.ch" />
          <p style="margin-top:1rem"><button class="btn" type="submit">Send magic link</button></p>
        </form>
        <p class="muted">Staff admin stays at <code>/admin</code> (Tinyauth). This portal is customer-only.</p>`,
      }),
    );
  });

  router.post("/login", (req, res) => {
    const email = String(req.body.email || "").trim();
    const ip = clientIp(req);
    const genericMsg =
      "Check your email (dev: see server logs)";

    // Always show generic success (no email enumeration)
    const redirectOk = () =>
      res.redirect(
        303,
        `/account/login?msg=${encodeURIComponent(genericMsg)}`,
      );

    if (!email) {
      return res.redirect(
        303,
        `/account/login?err=${encodeURIComponent("Email required")}`,
      );
    }

    const rlIp = rateLimitMagicLink(ip);
    const rlEmail = rateLimitMagicLink(email.toLowerCase());
    if (!rlIp.ok || !rlEmail.ok) {
      return res.redirect(
        303,
        `/account/login?err=${encodeURIComponent("Too many requests — try again in 15 minutes")}`,
      );
    }

    const customer = getCustomerByEmail(email);
    if (!customer) {
      // Still generic — do not reveal missing email
      console.log(`[magic-link] no customer for email=${email.toLowerCase()} (stub success)`);
      return redirectOk();
    }

    try {
      const raw = createMagicLinkToken(customer.id, {
        ttlSeconds: MAGIC_TTL_SEC,
        ip,
      });
      const url = `${siteUrl()}/account/login/consume?token=${encodeURIComponent(raw)}`;
      sendMagicLinkEmail({
        email: customer.email,
        url,
        customerId: customer.id,
        ip,
      });
    } catch (err) {
      console.error("[magic-link] create failed", err);
      return res.redirect(
        303,
        `/account/login?err=${encodeURIComponent("Could not send link")}`,
      );
    }
    return redirectOk();
  });

  router.get("/login/consume", (req, res) => {
    const token = String(req.query.token || "").trim();
    const customer = consumeMagicLinkToken(token);
    if (!customer) {
      return res.redirect(
        303,
        `/account/login?err=${encodeURIComponent("Invalid or expired link")}`,
      );
    }
    setAccountSessionCookie(res, customer.id);
    return res.redirect(303, "/account");
  });

  router.post("/logout", (_req, res) => {
    clearAccountSessionCookie(res);
    return res.redirect(303, "/account/login?msg=" + encodeURIComponent("Signed out"));
  });

  // --- Authenticated ---
  router.use(requireAccountSession);

  router.get("/", (req, res) => {
    const c = req.accountCustomer;
    const overview = getCustomerOverview(c.id);
    if (!overview) {
      clearAccountSessionCookie(res);
      return res.redirect(303, "/account/login");
    }
    const db = getDb();
    const orders = db
      .prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 20`)
      .all(c.id);
    const ents = overview.entitlements.filter((e) =>
      ["active", "trialing", "past_due"].includes(String(e.status || "").toLowerCase()),
    );
    const slug = c.repo_slug && String(c.repo_slug).trim() ? String(c.repo_slug).trim() : "";
    const repoPath = slug ? `customers/${slug}` : "—";
    const hasSsh = overview.has_ssh_key;
    const mm = overview.mismatches;
    const alerts = [];
    if (mm.active_without_overlay_job.length) {
      alerts.push(
        `<div class="alert warn"><strong>Note:</strong> active service without overlay job yet: ${mm.active_without_overlay_job.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ")}</div>`,
      );
    }
    if (mm.ssh_without_gitea_deploy_key) {
      alerts.push(
        `<div class="alert warn"><strong>Pending:</strong> SSH key saved — Credentials will attach a read-only Gitea deploy key shortly.</div>`,
      );
    }
    if (mm.repo_without_ssh) {
      alerts.push(
        `<div class="alert"><strong>Next step:</strong> add your Neo SSH <em>public</em> key on the <a href="/account/ssh">SSH</a> page.</div>`,
      );
    }

    const orderRows = orders
      .map(
        (o) =>
          `<tr><td>#${o.id}</td><td>${escapeHtml(o.status || "")}</td><td class="muted">${escapeHtml(o.created_at || "")}</td></tr>`,
      )
      .join("");
    const entRows = ents
      .map(
        (e) =>
          `<tr><td>${escapeHtml(e.service_id)}</td><td>${escapeHtml(e.status || "")}</td></tr>`,
      )
      .join("");

    const fp =
      hasSsh && c.neo_ssh_public_key
        ? `<code>…${escapeHtml(fingerprintShort(c.neo_ssh_public_key))}</code>`
        : "—";

    res.type("html").send(
      accountLayout({
        title: "Overview",
        body: `
        <h1>Your account</h1>
        ${flash(req.query)}
        ${alerts.join("")}
        <div class="card">
          <p><strong>Email:</strong> ${escapeHtml(c.email)}</p>
          <p><strong>Display name:</strong> ${escapeHtml(c.display_name || "—")}
            · <strong>Machine:</strong> ${escapeHtml(c.machine_label || "—")}</p>
          <p><strong>Private repo:</strong> <code>${escapeHtml(repoPath)}</code></p>
          <p><strong>SSH public key:</strong> ${hasSsh ? "yes" : "no"}
            ${hasSsh ? ` · fingerprint ${fp}` : ""}
            · <strong>Gitea deploy key id:</strong> <code>${escapeHtml(c.gitea_deploy_key_id || "—")}</code></p>
          <p class="muted">We never ask for or store your private key.</p>
          <p>
            <a class="btn" href="/account/ssh">Manage SSH key</a>
            <a class="btn secondary" href="/account/setup">Setup instructions</a>
          </p>
        </div>
        <h2>Orders</h2>
        <div class="card" style="overflow-x:auto">
          <table class="admin-table">
            <thead><tr><th>ID</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>${orderRows || `<tr><td colspan="3" class="muted">None yet</td></tr>`}</tbody>
          </table>
        </div>
        <h2>Active entitlements</h2>
        <div class="card" style="overflow-x:auto">
          <table class="admin-table">
            <thead><tr><th>Service</th><th>Status</th></tr></thead>
            <tbody>${entRows || `<tr><td colspan="2" class="muted">None</td></tr>`}</tbody>
          </table>
        </div>`,
      }),
    );
  });

  router.get("/ssh", (req, res) => {
    const c = req.accountCustomer;
    const hasSsh = Boolean(c.neo_ssh_public_key && String(c.neo_ssh_public_key).trim());
    const fp = hasSsh ? fingerprintShort(c.neo_ssh_public_key) : "";
    res.type("html").send(
      accountLayout({
        title: "SSH key",
        body: `
        <h1>Neo SSH public key</h1>
        ${flash(req.query)}
        <div class="alert warn"><strong>Never paste your private key</strong> (files named <code>id_ed25519</code> without <code>.pub</code>, or lines starting with <code>-----BEGIN</code>). Only the <code>.pub</code> line.</div>
        <div class="card">
          <p><strong>Status:</strong> ${hasSsh ? `<span class="ok">set</span> · fingerprint <code>…${escapeHtml(fp)}</code>` : `<span class="muted">not set</span>`}</p>
          ${hasSsh ? `<pre style="white-space:pre-wrap;font-size:0.8rem;overflow-x:auto">${escapeHtml(c.neo_ssh_public_key)}</pre>` : ""}
          <form method="post" action="/account/ssh">
            <label>OpenSSH public key (ssh-ed25519 / ssh-rsa / ecdsa- / sk-…)</label>
            <textarea name="public_key" rows="3" placeholder="ssh-ed25519 AAAA… comment" required>${escapeHtml(hasSsh ? c.neo_ssh_public_key : "")}</textarea>
            <p style="margin-top:1rem">
              <button class="btn" type="submit">Save / rotate key</button>
              ${hasSsh ? `<button class="btn secondary" type="submit" name="clear" value="1" formnovalidate>Clear key</button>` : ""}
            </p>
          </form>
          <p class="muted">Saving enqueues Credentials job <code>attach_gitea_deploy_key</code> (read-only deploy key on your private repo).</p>
        </div>
        <p><a href="/account">← Account</a></p>`,
      }),
    );
  });

  router.post("/ssh", (req, res) => {
    const c = req.accountCustomer;
    const clear = String(req.body.clear || "") === "1";
    try {
      if (clear) {
        updateCustomerSshKey(c.id, null);
        return res.redirect(
          303,
          `/account/ssh?msg=${encodeURIComponent("SSH key cleared")}`,
        );
      }
      const raw = String(req.body.public_key || "").trim();
      if (!isValidSshPublicKey(raw)) {
        return res.redirect(
          303,
          `/account/ssh?err=${encodeURIComponent("Invalid SSH public key")}`,
        );
      }
      // Reject obvious private-key pastes
      if (
        raw.includes("BEGIN") ||
        raw.includes("PRIVATE KEY") ||
        raw.startsWith("-----")
      ) {
        return res.redirect(
          303,
          `/account/ssh?err=${encodeURIComponent("That looks like a private key — paste only the .pub line")}`,
        );
      }
      updateCustomerSshKey(c.id, raw);
      enqueueAttachDeployKeyJob(c.id);
      const fp = fingerprintShort(raw);
      return res.redirect(
        303,
        `/account/ssh?msg=${encodeURIComponent(`SSH key saved (…${fp}). Deploy-key job queued.`)}`,
      );
    } catch (err) {
      console.error("[account] ssh update", err);
      return res.redirect(
        303,
        `/account/ssh?err=${encodeURIComponent(err.message || "Update failed")}`,
      );
    }
  });

  router.get("/setup", (req, res) => {
    const c = req.accountCustomer;
    const overview = getCustomerOverview(c.id);
    const slug = c.repo_slug && String(c.repo_slug).trim() ? String(c.repo_slug).trim() : "";
    const giteaBase = String(process.env.GITEA_BASE_URL || "").replace(/\/$/, "");
    const repoPath = slug ? `customers/${slug}` : "(repo pending)";
        const cloneHint = slug
      ? giteaBase
        ? `git clone git@${giteaBase.replace(/^https?:\/\//, "")}:${repoPath}.git`
        : `git clone <gitea-host>:${repoPath}.git`
      : "Repo slug not assigned yet.";
    const hasDeploy = Boolean(
      c.gitea_deploy_key_id && String(c.gitea_deploy_key_id).trim(),
    );
    const ents = (overview?.entitlements || []).filter((e) =>
      ["active", "trialing", "past_due"].includes(String(e.status || "").toLowerCase()),
    );
    const overlayList = ents.length
      ? `<ul>${ents.map((e) => `<li><code>${escapeHtml(e.service_id)}</code> (${escapeHtml(e.status || "")})</li>`).join("")}</ul>`
      : `<p class="muted">No active entitlements yet.</p>`;

    const pathH = hasDeploy
      ? `<div class="alert ok"><strong>Already enrolled (Path H / factory or prior Path S).</strong> Deploy key id <code>${escapeHtml(c.gitea_deploy_key_id)}</code> is on file — you can pull the private repo with the Neo deploy key.</div>`
      : `<div class="alert"><strong>Path S:</strong> submit your SSH public key on <a href="/account/ssh">SSH</a>; Credentials attaches a read-only Gitea deploy key. <strong>Path H:</strong> staff factory token may attach the key after neo activate (no unauthenticated claim).</div>`;

    res.type("html").send(
      accountLayout({
        title: "Setup",
        body: `
        <h1>Neo setup</h1>
        ${flash(req.query)}
        ${pathH}
        <div class="card">
          <h2>1. Credentials plugin</h2>
          <p>Add the Neo plugin:</p>
          <pre><code>github:heimcloud/credentials</code></pre>
          <p class="muted">Contact <a href="mailto:heimcloud@proton.me">heimcloud@proton.me</a> if you need access.</p>
        </div>
        <div class="card">
          <h2>2. Private customer repo</h2>
          <p>Path: <code>${escapeHtml(repoPath)}</code>
            ${giteaBase && slug ? ` · <a href="${escapeHtml(giteaBase)}/${escapeHtml(repoPath)}" target="_blank" rel="noopener">open</a>` : ""}</p>
          <p>Clone uses the <strong>deploy key</strong> Credentials attaches (read-only). Example:</p>
          <pre><code>${escapeHtml(cloneHint)}</code></pre>
          <p class="muted">Set <code>GITEA_BASE_URL</code> on the shop for exact clone URLs.</p>
        </div>
        <div class="card">
          <h2>3. Entitled overlays</h2>
          ${overlayList}
        </div>
        <p><a href="/account">← Account</a></p>`,
      }),
    );
  });

  return router;
}
