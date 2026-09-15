# Heimcloud Shop

Neo plugin: Swiss-market storefront for **ZimaBlade / NAS kits**, managed services, and Stripe Checkout (CHF).

Public reverse proxy with **auth off** (same pattern as [portrait](https://github.com/madebydamo/portrait)). Hardware orders fulfill in a **month-end batch**; services are **monthly subscriptions**.

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
5. Subdomain defaults to `shop` (`shop.<your-domain>`). Auth is **disabled** for a public storefront.
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

### Checkout modes

- **Hardware only** → `mode: payment` with the kit Price ID (rack/storage/shipping add-ons via `price_data`).
- **Any services** (services-only or kit + services) → `mode: subscription` with recurring Price IDs; if the cart includes the kit, the one-time kit Price ID is added to the same Checkout Session `line_items`.

### Webhooks

| Item | Value |
|------|-------|
| URL | `https://shop.heimcloud.site/api/stripe/webhook` (or your `SITE_URL` + `/api/stripe/webhook`) |
| Events | `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` |
| Idempotency | `webhook_events.stripe_event_id` UNIQUE |

On paid/completed: upsert **customer**, insert **order**, upsert **entitlements** from line items / subscription, insert a **provisioning_jobs** stub row (email, services, kit config placeholders).

Copy `app/.env.example` for local runs. **Never commit real `sk_` / `pk_` / `whsec_` keys.**

## SQLite schema (WAL)

Opened with `PRAGMA journal_mode=WAL;` and `PRAGMA foreign_keys=ON;`. Migrations run on boot.

| Table | Purpose |
|-------|---------|
| `customers` | `id`, `email` UNIQUE, `stripe_customer_id` UNIQUE, timestamps |
| `orders` | `customer_id` FK, `stripe_session_id` UNIQUE, `mode` payment\|subscription, amounts, `kit_config_json`, `line_items_json`, `status` |
| `entitlements` | per-customer service (`public_ip`\|`airvpn`\|`hermes`\|`backups`), Stripe subscription/price, `status`, `current_period_end` |
| `provisioning_jobs` | stub queue for Credentials later (`pending`\|`done`\|`failed`) |
| `webhook_events` | Stripe event id idempotency |

### Backup (Neo host)

Container path: `/data/shop.sqlite`  
Host (Neo appdata): **`${neo.core.volumes.appdata}/shop/shop.sqlite`**  
(typically something like `/var/lib/neo/appdata/shop/shop.sqlite` or your configured appdata root + `/shop/shop.sqlite`).

With WAL, also back up `-wal` / `-shm` siblings if present:

1. **Preferred online:** `sqlite3 /path/to/shop.sqlite ".backup '/path/to/shop.backup.sqlite'"`
2. **Cold copy:** stop the shop container, then copy `shop.sqlite` plus `shop.sqlite-wal` and `shop.sqlite-shm` if they exist, then start again.

## Container image

Default image name: `heimcloud/shop:latest` (local build). Uses **better-sqlite3** (native); deps stage installs `python3`/`make`/`g++` on Alpine. `/data` is created writable; Neo mounts appdata there.

```bash
docker build -t heimcloud/shop:latest .
# optional: tag & push to GHCR, then change mkContainerDefinitions to
# ghcr.io/heimcloud/shop:latest
```

App listens on **3000**, `TZ=Europe/Zurich`, network `internal`, volume `/data`.

### Fleet / redeploy notes

- Volume: `${appdata}/shop:/data` (already in `modules/services/shop/default.nix`)
- Env: `SHOP_DB_PATH=/data/shop.sqlite`, `STRIPE_WEBHOOK_SECRET`, plus existing Stripe keys/price IDs and `SITE_URL`
- Rebuild image after this change so `better-sqlite3` is present
- Point Stripe Dashboard (or API) webhook at `https://shop.heimcloud.site/api/stripe/webhook` with the events listed above

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
| `POST /api/stripe/webhook` | Stripe signed webhooks → SQLite |
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
modules/
  imports.nix  inputs.nix  nixos.nix
  services/shop/
    option.nix  default.nix  swag.nix
app/          # storefront + lib/db.js + lib/webhooks.js
Dockerfile
```

## Fulfillment

Paid hardware orders are intended for **month-end batch** shipping to CH addresses. Subscriptions renew monthly. `provisioning_jobs` rows are stubs for a future Credentials provider — no real provider APIs in this MVP.
