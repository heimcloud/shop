# Heimcloud Shop

Neo plugin: Swiss-market storefront for **ZimaBlade / NAS kits**, managed services, and Stripe Checkout (CHF).

Public reverse proxy with **whole-site auth off** (same pattern as [portrait](https://github.com/madebydamo/portrait)) so the storefront stays public. **Admin** at `/admin` (and `/api/admin`) is gated by **Tinyauth** at the Neo SWAG edge when `admin.auth = true`. Hardware orders fulfill in a **month-end batch**; services are **monthly subscriptions**.

Orders and entitlements persist in **SQLite (WAL)** under the Neo appdata volume. Stripe webhooks at `POST /api/stripe/webhook` upsert customers, orders, entitlements, and stub provisioning jobs (Credentials providers later — no real xAI/rsync/AirVPN/Hostkey calls yet).

## Commercial model

| Item | Billing | Example CHF | Stripe Test price ID (default) |
|------|---------|-------------|-------------------------------|
| ZimaBlade kit | one-time | 499 | `price_1UFvgv1oIIxcEEBR67p9pqaf` |
| Public IP | monthly | 12 | `price_1UFviO1oIIxcEEBRE6vE1O4L` |
| AirVPN | monthly | 9 | `price_1UFvjR1oIIxcEEBR8aHsaXaA` |
| Hermes AI tokens | monthly | 19 | `price_1UFvke1oIIxcEEBR2ZyLrPyV` |
| Backups | monthly | 8 | `price_1UFvmL1oIIxcEEBRAVZNH5s7` |

Price IDs are **not secrets** — safe in `.env.example` / docs. Override with env vars below.

## Install on Neo

1. Open **Neo web → Settings → core → plugins**.
2. Add:

   ```text
   github:heimcloud/shop
   ```

3. Apply / activate so the plugin loads.
4. Enable **shop** under Services.
5. Subdomain defaults to `shop` (`shop.<your-domain>`). Service `auth.enabled` stays **false** (public storefront). Admin paths are Tinyauth-protected separately when `admin.auth` is true.
6. Set Stripe secrets (including `stripeWebhookSecret`) and ensure the container has the `/data` volume (default: `${appdata}/shop:/data`).

See Neo’s [PLUGINS.md](https://github.com/madebydamo/neo/blob/master/docs/PLUGINS.md).

## Stripe (no secrets in git)

Leave `STRIPE_SECRET_KEY` empty until ready. The UI shows **payments not configured** and disables checkout. Sessions are created **only** when the secret key is set.

| Option / env | Purpose |
|--------------|---------|
| `stripeSecretKey` / `STRIPE_SECRET_KEY` | Server Checkout Sessions (secret) |
| `stripePublishableKey` / `STRIPE_PUBLISHABLE_KEY` / `PUBLIC_STRIPE_PUBLISHABLE_KEY` | Client (reserved) |
| `stripeWebhookSecret` / `STRIPE_WEBHOOK_SECRET` | Webhook signature (`whsec_…`) for `/api/stripe/webhook` |
| `siteUrl` / `SITE_URL` | Success/cancel URLs |
| `SHOP_DB_PATH` | SQLite file path (default `/data/shop.sqlite`) |
| `stripePriceKit` / `STRIPE_PRICE_KIT` | One-time kit Price ID |
| `stripePricePublicIp` / `STRIPE_PRICE_PUBLIC_IP` | Public IP monthly Price ID |
| `stripePriceAirvpn` / `STRIPE_PRICE_AIRVPN` | AirVPN monthly Price ID |
| `stripePriceHermes` / `STRIPE_PRICE_HERMES` | Hermes monthly Price ID |
| `stripePriceBackups` / `STRIPE_PRICE_BACKUPS` | Backups monthly Price ID |
| `admin.enabled` / `ADMIN_ENABLED` | Enable in-app admin UI (default true; 404 when false) |
| `admin.path` / `ADMIN_PATH` | Admin URL path, no trailing slash (default `/admin`) |
| `admin.auth` | SWAG Tinyauth on admin locations only (default true; does **not** flip whole-site auth) |
| `admin.readOnly` / `ADMIN_READ_ONLY` | Disable mutating admin forms (default false) |
| `provisioningApiToken` / `PROVISIONING_API_TOKEN` | Shared secret for Credentials `/api/internal/provisioning/*` |

### Checkout modes

- **Hardware only** → `mode: payment` with the kit Price ID (rack/storage/shipping add-ons via `price_data`).
- **Any services** (services-only or kit + services) → `mode: subscription` with recurring Price IDs; if the cart includes the kit, the one-time kit Price ID is added to the same Checkout Session `line_items`.

### Webhooks

| Item | Value |
|------|-------|
| URL | `https://shop.heimcloud.site/api/stripe/webhook` (or your `SITE_URL` + `/api/stripe/webhook`) |
| Events | `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` |
| Idempotency | `webhook_events.stripe_event_id` UNIQUE |

On paid/completed: upsert **customer**, insert **order**, upsert **entitlements** from line items / subscription, insert a **provisioning_jobs** stub row (email, services, kit config placeholders). Active/trialing entitlements also enqueue a deduped **`ensure_config_overlay`** job for Credentials.

Copy `app/.env.example` for local runs. **Never commit real `sk_` / `pk_` / `whsec_` keys.**

## SQLite schema (WAL)

Opened with `PRAGMA journal_mode=WAL;` and `PRAGMA foreign_keys=ON;`. Migrations run on boot.

| Table | Purpose |
|-------|---------|
| `customers` | `id`, `email` UNIQUE, `stripe_customer_id` UNIQUE, `display_name`, `machine_label` (unique when set), `repo_slug` UNIQUE (Crockford base32, 10 chars), `neo_ssh_public_key`, `gitea_deploy_key_id`, timestamps |
| `orders` | `customer_id` FK, `stripe_session_id` UNIQUE, `mode` payment\|subscription, amounts, `kit_config_json`, `line_items_json`, `status` |
| `entitlements` | per-customer service (`public_ip`\|`airvpn`\|`hermes`\|`backups`), Stripe subscription/price, `status`, `current_period_end` |
| `provisioning_jobs` | stub queue for Credentials (`pending`\|`claimed`\|`done`\|`failed`); optional `notes` TEXT |
| `webhook_events` | Stripe event id idempotency |


## Central user ledger

Shop SQLite is the preferred **central ledger** linking customers ↔ Credentials `repo_slug` ↔ orders/subscriptions ↔ SSH keys ↔ machine labels for lab accounts.

| Field | Role |
|-------|------|
| `email` | Customer identity (unique) |
| `display_name` / `machine_label` | Human / lab host labels (admin-editable) |
| `repo_slug` | Opaque Credentials repo id under `customers/<slug>` — never overwritten once set |
| `neo_ssh_public_key` / `gitea_deploy_key_id` | Deploy-key attach state for Credentials |

**Lab seeds** (idempotent on migrate):

| Email | display_name / machine_label | repo_slug |
|-------|------------------------------|-----------|
| `hattori@heimcloud.site` | hattori | `KAKJWG9RM5` |
| `thatch@heimcloud.site` | thatch | `W4ZGSG7SYJ` |

**Admin:** `/admin` overview · `/admin/customers` list (repo, SSH, active ents) · `/admin/customers/:id` detail with mismatch alerts (active entitlement without `ensure_config_overlay` job; SSH without gitea deploy key id; repo without SSH).

**Pipeline stub:** when an entitlement becomes `active` or `trialing`, Shop inserts a single `ensure_config_overlay` provisioning job (`model: config-overlay`) so Credentials can create the overlay folder layout. Deduped on pending/claimed/done per customer+service.

Optional env: `GITEA_BASE_URL` — when set, admin links `repo_slug` to `${GITEA_BASE_URL}/customers/<slug>`.

### Backup (Neo host)

Container path: `/data/shop.sqlite`  
Host (Neo appdata): **`${neo.core.volumes.appdata}/shop/shop.sqlite`**  
(typically something like `/var/lib/neo/appdata/shop/shop.sqlite` or your configured appdata root + `/shop/shop.sqlite`).

With WAL, also back up `-wal` / `-shm` siblings if present:

1. **Preferred online:** `sqlite3 /path/to/shop.sqlite ".backup '/path/to/shop.backup.sqlite'"`
2. **Cold copy:** stop the shop container, then copy `shop.sqlite` plus `shop.sqlite-wal` and `shop.sqlite-shm` if they exist, then start again.

## Container image

Neo builds and loads the image from the flake package (`package.nix` → `pkgs.dockerTools.buildLayeredImage`). Activate / apply is enough — **no manual `docker build`** on the homeserver.

| Piece | Value |
|-------|--------|
| Flake package | `nix build .#heimcloud-shop` (optional local check) |
| OCI `image` | `heimcloud-shop:latest` (must match package name:tag) |
| OCI `imageFile` | derivation from `package.nix` (always set by the module) |
| Listen | **3000**, `TZ=Europe/Zurich`, network `internal`, volume `/data` |

**User / appdata:** container runs as `neo.core.uid:neo.core.gid` (defaults **1000:1000**), same as dufs. `docker-shop.preStart` uses `lib.neo.mkEnsureDirs` so `${appdata}/shop` is created with that ownership. SQLite opens `/data/shop.sqlite` on the mounted volume.

Settings override `containers.shop` only changes the **tag name** docker/podman will label the loaded `imageFile` with — Neo still builds from Nix. Dockerfile remains for non-Nix local experimentation only.

### Fleet / redeploy notes

- Volume: `${appdata}/shop:/data` (module); host dir ownership = **neo.core.uid/gid** (preStart via `mkEnsureDirs`)
- Env: `SHOP_DB_PATH=/data/shop.sqlite`, `STRIPE_WEBHOOK_SECRET`, admin (`ADMIN_*`), plus existing Stripe keys/price IDs and `SITE_URL`
- Activate rebuilds/loads the Nix image (includes native `better-sqlite3`)
- Point Stripe Dashboard (or API) webhook at `https://shop.heimcloud.site/api/stripe/webhook` with the events listed above

## Credentials provisioning API

Internal HTTP API for the [Credentials](https://github.com/heimcloud/credentials) Neo plugin to claim and complete `provisioning_jobs`. **Not** Tinyauth-gated — auth is a shared secret. Routes stay on the public SWAG `location /` (same as Stripe webhooks); you can add IP allowlists later if desired.

| Item | Value |
|------|--------|
| Base | `https://shop.<domain>/api/internal/provisioning` |
| Auth | `Authorization: Bearer $PROVISIONING_API_TOKEN` or `X-Provisioning-Token: $TOKEN` |
| Neo option / env | `provisioningApiToken` / `PROVISIONING_API_TOKEN` |
| DB | `${appdata}/shop/shop.sqlite` (`SHOP_DB_PATH=/data/shop.sqlite`) |

If the token is unset → **503** `provisioning_api_not_configured`. Wrong/missing token → **401**.

### Routes

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/jobs?status=pending&limit=50` | List jobs (default `pending`), joined customer fields (`email`, `stripe_customer_id`, `repo_slug`, `has_ssh_key`, `neo_ssh_public_key`, `gitea_deploy_key_id`), `payload` parsed from `payload_json` |
| `POST` | `/jobs/:id/claim` | Atomically `pending` → `claimed` (optional body `{ "worker": "credentials" }`). **409** if not pending. Same joined customer fields as list |
| `POST` | `/jobs/:id/complete` | Body `{ "notes"?, "result_json"? }` → `done` (must be `claimed`). Merges `result_json` into payload as `result` |
| `POST` | `/jobs/:id/fail` | Body `{ "notes"? }` → `failed` (must be `claimed`) |
| `GET` | `/customers/:id` | Customer: `email`, `stripe_customer_id`, `repo_slug`, `has_ssh_key`, `neo_ssh_public_key`, `gitea_deploy_key_id` |
| `POST` | `/customers/:id/ssh-key` | Body `{ "public_key": "ssh-ed25519 AAAA… comment", "gitea_deploy_key_id"? }`. Validates non-empty OpenSSH pubkey (`ssh-ed25519` / `ssh-rsa` / `ecdsa-` / `sk-`). Stores trimmed key; bumps `updated_at`. **404** if missing; **400** if invalid |
| `PATCH`/`POST` | `/customers/:id` | Body `{ "gitea_deploy_key_id": "42" \| null }` — record Gitea deploy key id after Credentials attaches it |

Job statuses: `pending` \| `claimed` \| `done` \| `failed`.

### Job payload shape (from Stripe webhooks)

Stub jobs are inserted on checkout / invoice flows as `job_type: "provision_stub"` with JSON roughly:

```json
{
  "email": "customer@example.com",
  "services": ["public_ip", "airvpn", "hermes", "backups"],
  "kit_config": { },
  "stripe_session_id": "cs_test_…",
  "stripe_subscription_id": "sub_…",
  "note": "Stub only — no real provider API calls"
}
```

List/claim responses include the same fields plus `id`, `customer_id`, `order_id`, `status`, `notes`, `email`, `stripe_customer_id`, `repo_slug`, `has_ssh_key`, `neo_ssh_public_key`, `gitea_deploy_key_id`, timestamps.

### SSH key + `repo_slug` (Credentials / Neo)

Shop **only stores** the customer's Neo SSH public key and opaque `repo_slug` for Gitea paths — it does **not** flip repo visibility. Credentials should use `repo_slug` (Crockford base32, 8–10 chars, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`) for the Gitea repo path instead of `customer-<id>`. Legacy numeric paths may remain.

`repo_slug` is generated on customer create (and ensured on first provisioning job / list/claim if still null).

**`POST /customers/:id/ssh-key` request:**

```json
{ "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample comment", "gitea_deploy_key_id": "42" }
```

**Response:**

```json
{
  "id": 1,
  "email": "customer@example.com",
  "repo_slug": "A1B2C3D4E5",
  "has_ssh_key": true,
  "gitea_deploy_key_id": "42",
  "key_fingerprint": "hex-sha256-of-trimmed-key"
}
```

**`GET /customers/:id` response:**

```json
{
  "customer": {
    "id": 1,
    "email": "customer@example.com",
    "stripe_customer_id": "cus_…",
    "repo_slug": "A1B2C3D4E5",
    "has_ssh_key": true,
    "neo_ssh_public_key": "ssh-ed25519 AAAA… comment",
    "gitea_deploy_key_id": "42",
    "created_at": "…",
    "updated_at": "…"
  }
}
```

**Job list/claim** each job object also includes `repo_slug`, `has_ssh_key`, `neo_ssh_public_key`, and `gitea_deploy_key_id` so Credentials can attach a read-only Gitea deploy key.

## Admin UI (Tinyauth-gated)

URL: **`https://shop.<your-domain>/admin`** (or `SITE_URL` + `ADMIN_PATH`). Also mounted at `/api/admin`.

| Knob | Default | Effect |
|------|---------|--------|
| `admin.enabled` | `true` | In-app admin routes; `false` → 404 |
| `admin.path` | `/admin` | Mount path (no trailing slash) |
| `admin.auth` | `true` | SWAG Tinyauth on `${admin.path}`, `${admin.path}/`, and `/api/admin` only |
| `admin.readOnly` | `false` | Mutating POSTs return 403 / no-op |

**Storefront stays public.** Do **not** set service-level `auth.enabled = true` — that would lock the whole shop. Tinyauth is applied only to admin locations in `modules/services/shop/swag.nix` (same `tinyauth-location.conf` / `tinyauth-server.conf` snippets as `lib.neo.authBlock` / `authLocations`). `POST /api/stripe/webhook` remains under unauthenticated `location /`.

If `admin.auth` is false but `admin.enabled` is true, admin routes work without Tinyauth (**dev only**).

### Pages

| Path | What |
|------|------|
| `GET …/` | Overview: counts, recent orders, webhooks, pending jobs |
| `GET …/customers` | Searchable list (`q=email`) |
| `GET/POST …/customers/:id` | Detail; edit email; Neo SSH key set/rotate/clear + `gitea_deploy_key_id` / `repo_slug` (respects `ADMIN_READ_ONLY`); Stripe Dashboard link |
| `GET …/orders`, `…/orders/:id` | kit_config, line_items, status, session id |
| `GET …/entitlements` | List with customer email; cancel at period end / cancel immediately (confirm POSTs) |
| `GET/POST …/jobs` | Provisioning jobs; set `pending`\|`done`\|`failed` + optional notes |

**Cancel behaviors** (requires `STRIPE_SECRET_KEY`):

- **Cancel at period end** → `stripe.subscriptions.update(id, { cancel_at_period_end: true })`
- **Cancel immediately** → `stripe.subscriptions.cancel(id)`
- Dashboard links use `https://dashboard.stripe.com/test/…` for test keys; live keys (`sk_live_…`) omit `/test`
- Without `STRIPE_SECRET_KEY`, cancel buttons are disabled and a message is shown

## App routes

| Path | What |
|------|------|
| `/` | Hero + CTAs |
| `/kit` | Configurator (rack / SSD / HDD, one-time CHF, CH shipping, month-end banner) |
| `/mini-pc` | Coming soon + interest email stub |
| `/services` | Monthly: public IP, AirVPN, Hermes tokens, backups |
| `/order` | Summary + Swiss address → Stripe Checkout when configured |
| `/order/thanks` | Confirmation |
| `/legal` | Impressum / privacy / AGB stubs |
| `POST /api/stripe/webhook` | Stripe signed webhooks → SQLite (public) |
| `/admin`, `/api/admin` | Admin UI (Tinyauth at edge when `admin.auth`) |
| `/healthz` | Liveness + payments/webhook/db flags |

Stack: lean **Express** Node app + **better-sqlite3**.

## Local dev

```bash
cd app
cp .env.example .env
# For local SQLite without /data:
# SHOP_DB_PATH=./data/shop.sqlite
npm install
npm run dev   # or npm start
```

## Plugin layout

```
flake.nix
package.nix                 # buildNpmPackage + dockerTools image
modules/
  imports.nix  inputs.nix  nixos.nix
  packages/heimcloud-shop-image.nix   # perSystem packages.heimcloud-shop
  services/shop/
    option.nix  default.nix  swag.nix
app/          # storefront + lib/db.js + lib/webhooks.js
Dockerfile    # optional non-Nix local only
```

## Fulfillment

Paid hardware orders are intended for **month-end batch** shipping to CH addresses. Subscriptions renew monthly. `provisioning_jobs` rows are stubs for a future Credentials provider — no real provider APIs in this MVP.
