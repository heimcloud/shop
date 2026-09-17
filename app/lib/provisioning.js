/**
 * Internal provisioning jobs API for Credentials (Bearer / X-Provisioning-Token).
 * Mount at /api/internal/provisioning — not Tinyauth; shared-secret only.
 */
import { createHash } from "node:crypto";
import { Router } from "express";
import {
  getDb,
  getCustomerById,
  ensureCustomerRepoSlug,
  updateCustomerSshKey,
  updateCustomerGiteaDeployKeyId,
  listProvisioningJobs,
  claimProvisioningJob,
  completeProvisioningJob,
  failProvisioningJob,
} from "./db.js";

function getToken() {
  return process.env.PROVISIONING_API_TOKEN || "";
}

export function requireProvisioningToken(req, res, next) {
  const token = getToken();
  if (!token) {
    return res.status(503).json({ error: "provisioning_api_not_configured" });
  }
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const header = String(req.headers["x-provisioning-token"] || "").trim();
  if (bearer !== token && header !== token) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

/** Accept common OpenSSH public key type prefixes (non-empty). */
export function isValidSshPublicKey(raw) {
  if (raw == null) return false;
  const key = String(raw).trim();
  if (!key) return false;
  const okPrefix =
    key.startsWith("ssh-ed25519 ") ||
    key.startsWith("ssh-rsa ") ||
    key.startsWith("ecdsa-") ||
    key.startsWith("sk-");
  if (!okPrefix) return false;
  const parts = key.split(/\s+/);
  // type + key material (+ optional comment)
  return parts.length >= 2 && Boolean(parts[1]);
}

export function sshKeyFingerprintSha256(publicKey) {
  const key = String(publicKey).trim();
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function customerHasSshKey(row) {
  return Boolean(row?.neo_ssh_public_key && String(row.neo_ssh_public_key).trim());
}

function parseCustomer(row) {
  return {
    id: row.id,
    email: row.email ?? null,
    stripe_customer_id: row.stripe_customer_id ?? null,
    display_name: row.display_name ?? null,
    machine_label: row.machine_label ?? null,
    repo_slug: row.repo_slug ?? null,
    has_ssh_key: customerHasSshKey(row),
    neo_ssh_public_key: row.neo_ssh_public_key ?? null,
    gitea_deploy_key_id: row.gitea_deploy_key_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parsePayload(row) {
  let payload = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
  }
  const hasKey =
    row.has_ssh_key === 1 ||
    row.has_ssh_key === true ||
    Boolean(row.neo_ssh_public_key && String(row.neo_ssh_public_key).trim());
  return {
    id: row.id,
    customer_id: row.customer_id,
    order_id: row.order_id,
    job_type: row.job_type,
    status: row.status,
    notes: row.notes ?? null,
    payload,
    email: row.email ?? null,
    stripe_customer_id: row.stripe_customer_id ?? null,
    display_name: row.display_name ?? null,
    machine_label: row.machine_label ?? null,
    repo_slug: row.repo_slug ?? null,
    has_ssh_key: Boolean(hasKey),
    neo_ssh_public_key: row.neo_ssh_public_key ?? null,
    gitea_deploy_key_id: row.gitea_deploy_key_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createProvisioningRouter() {
  const router = Router();
  router.use(requireProvisioningToken);

  router.get("/jobs", (req, res) => {
    const status = String(req.query.status || "pending").trim() || "pending";
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = listProvisioningJobs({ status, limit });
    return res.json({ jobs: rows.map(parsePayload) });
  });

  router.post("/jobs/:id/claim", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const worker =
      req.body && req.body.worker != null ? String(req.body.worker) : undefined;
    const row = claimProvisioningJob(id, { worker });
    if (!row) {
      const existing = getDb()
        .prepare(`SELECT id, status FROM provisioning_jobs WHERE id = ?`)
        .get(id);
      if (!existing) return res.status(404).json({ error: "not_found" });
      return res.status(409).json({ error: "not_pending", status: existing.status });
    }
    return res.json({ job: parsePayload(row) });
  });

  router.post("/jobs/:id/complete", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const notes = req.body?.notes != null ? String(req.body.notes) : undefined;
    const resultJson = req.body?.result_json;
    const row = completeProvisioningJob(id, { notes, resultJson });
    if (!row) {
      const existing = getDb()
        .prepare(`SELECT id, status FROM provisioning_jobs WHERE id = ?`)
        .get(id);
      if (!existing) return res.status(404).json({ error: "not_found" });
      return res.status(409).json({ error: "not_claimable_state", status: existing.status });
    }
    return res.json({ job: parsePayload(row) });
  });

  router.post("/jobs/:id/fail", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const notes = req.body?.notes != null ? String(req.body.notes) : undefined;
    const row = failProvisioningJob(id, { notes });
    if (!row) {
      const existing = getDb()
        .prepare(`SELECT id, status FROM provisioning_jobs WHERE id = ?`)
        .get(id);
      if (!existing) return res.status(404).json({ error: "not_found" });
      return res.status(409).json({ error: "not_claimable_state", status: existing.status });
    }
    return res.json({ job: parsePayload(row) });
  });

  router.get("/customers/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }
    let row = getCustomerById(id);
    if (!row) return res.status(404).json({ error: "not_found" });
    if (!row.repo_slug || !String(row.repo_slug).trim()) {
      ensureCustomerRepoSlug(id);
      row = getCustomerById(id);
    }
    return res.json({ customer: parseCustomer(row) });
  });

  /**
   * Set or clear Neo SSH public key for Credentials deploy-key attach.
   * Body: { "public_key": "ssh-ed25519 AAAA… comment" } — empty string clears.
   * Optional: { "gitea_deploy_key_id": "123" } to record Gitea deploy key id.
   */
  router.post("/customers/:id/ssh-key", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }
    if (!getCustomerById(id)) {
      return res.status(404).json({ error: "not_found" });
    }

    const hasPublicKey =
      req.body && Object.prototype.hasOwnProperty.call(req.body, "public_key");
    const hasGiteaId =
      req.body && Object.prototype.hasOwnProperty.call(req.body, "gitea_deploy_key_id");

    if (!hasPublicKey && !hasGiteaId) {
      return res.status(400).json({ error: "invalid_public_key" });
    }

    let row = getCustomerById(id);

    if (hasPublicKey) {
      const raw = req.body.public_key;
      const trimmed = raw == null ? "" : String(raw).trim();
      if (!isValidSshPublicKey(trimmed)) {
        return res.status(400).json({ error: "invalid_public_key" });
      }
      row = updateCustomerSshKey(id, trimmed);
      if (!row) return res.status(404).json({ error: "not_found" });
    }

    if (hasGiteaId) {
      const gid = req.body.gitea_deploy_key_id;
      row = updateCustomerGiteaDeployKeyId(
        id,
        gid == null || String(gid).trim() === "" ? null : gid,
      );
      if (!row) return res.status(404).json({ error: "not_found" });
    }

    const out = {
      id: row.id,
      email: row.email,
      repo_slug: row.repo_slug ?? null,
      has_ssh_key: customerHasSshKey(row),
      gitea_deploy_key_id: row.gitea_deploy_key_id ?? null,
    };
    if (customerHasSshKey(row)) {
      out.key_fingerprint = sshKeyFingerprintSha256(row.neo_ssh_public_key);
    }
    return res.json(out);
  });

  /**
   * Patch customer fields used by Credentials (currently gitea_deploy_key_id).
   * Body: { "gitea_deploy_key_id": "123" | null }
   */
  router.patch("/customers/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }
    if (!getCustomerById(id)) {
      return res.status(404).json({ error: "not_found" });
    }
    if (
      !req.body ||
      !Object.prototype.hasOwnProperty.call(req.body, "gitea_deploy_key_id")
    ) {
      return res.status(400).json({ error: "missing_gitea_deploy_key_id" });
    }
    const gid = req.body.gitea_deploy_key_id;
    const row = updateCustomerGiteaDeployKeyId(
      id,
      gid == null || String(gid).trim() === "" ? null : gid,
    );
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json({ customer: parseCustomer(row) });
  });

  // Alias POST for environments that prefer POST over PATCH
  router.post("/customers/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }
    if (!getCustomerById(id)) {
      return res.status(404).json({ error: "not_found" });
    }
    if (
      !req.body ||
      !Object.prototype.hasOwnProperty.call(req.body, "gitea_deploy_key_id")
    ) {
      return res.status(400).json({ error: "missing_gitea_deploy_key_id" });
    }
    const gid = req.body.gitea_deploy_key_id;
    const row = updateCustomerGiteaDeployKeyId(
      id,
      gid == null || String(gid).trim() === "" ? null : gid,
    );
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json({ customer: parseCustomer(row) });
  });

  return router;
}
