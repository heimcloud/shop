/**
 * Internal provisioning jobs API for Credentials (Bearer / X-Provisioning-Token).
 * Mount at /api/internal/provisioning — not Tinyauth; shared-secret only.
 */
import { Router } from "express";
import {
  getDb,
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

function parsePayload(row) {
  let payload = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
  }
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

  return router;
}
