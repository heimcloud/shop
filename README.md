# Heimcloud Shop

Neo plugin: Swiss-market storefront for **ZimaBlade / NAS kits**, light service placeholders, and Stripe Checkout (CHF).

Public reverse proxy with **auth off** (same pattern as [portrait](https://github.com/madebydamo/portrait)). Orders are fulfilled in a **month-end batch**.

> **Prices in this MVP are examples** (e.g. kit base CHF 499, SSD/HDD options, CH shipping CHF 15). Replace before production.

## Install on Neo

1. Open **Neo web → Settings → core → plugins**.
2. Add:

   ```text
   github:heimcloud/shop
   ```

3. Apply / activate so the plugin loads.
4. Enable **shop** under Services.
5. Subdomain defaults to `shop` (`shop.<your-domain>`). Auth is **disabled** for a public storefront.

See Neo’s [PLUGINS.md](https://github.com/madebydamo/neo/blob/master/docs/PLUGINS.md).

## Stripe (later — no secrets in git)

Leave Stripe options empty until ready. The UI shows **payments not configured** and disables checkout.

When ready, set on the Neo shop service (or container env):

| Option / env | Purpose |
|--------------|---------|
| `stripeSecretKey` / `STRIPE_SECRET_KEY` | Server Checkout Sessions |
| `stripePublishableKey` / `STRIPE_PUBLISHABLE_KEY` / `PUBLIC_STRIPE_PUBLISHABLE_KEY` | Client (reserved) |
| `stripeWebhookSecret` / `STRIPE_WEBHOOK_SECRET` | Webhooks (reserved) |
| `siteUrl` / `SITE_URL` | Success/cancel URLs |

Copy `app/.env.example` for local runs. **Never commit real keys.**

## Container image

Default image name: `heimcloud/shop:latest` (local build).

```bash
docker build -t heimcloud/shop:latest .
# optional: tag & push to GHCR, then change mkContainerDefinitions to
# ghcr.io/heimcloud/shop:latest
```

App listens on **3000**, `TZ=Europe/Zurich`, network `internal`.

## App routes

| Path | What |
|------|------|
| `/` | Hero + CTAs |
| `/kit` | Configurator (rack / SSD / HDD, CHF, CH shipping, month-end banner) |
| `/mini-pc` | Coming soon + interest email stub |
| `/services` | Placeholders: public IP, AirVPN, Hermes tokens, backups |
| `/order` | Summary + Swiss address → Stripe Checkout when configured |
| `/order/thanks` | Confirmation + month-end copy |
| `/legal` | Impressum / privacy / AGB stubs |

Stack: lean **Express** Node app (Astro `create` required Node ≥22; this box is Node 20).

## Local dev

```bash
cd app
cp .env.example .env
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
app/          # storefront
Dockerfile
```

## Fulfillment

Paid orders are intended for **month-end batch** shipping to CH addresses. Operational tooling is out of scope for this MVP.
