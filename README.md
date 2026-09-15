# Heimcloud Shop

Neo plugin: Swiss-market storefront for **ZimaBlade / NAS kits**, managed services, and Stripe Checkout (CHF).

Public reverse proxy with **auth off** (same pattern as [portrait](https://github.com/madebydamo/portrait)). Hardware orders fulfill in a **month-end batch**; services are **monthly subscriptions**.

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

See Neo’s [PLUGINS.md](https://github.com/madebydamo/neo/blob/master/docs/PLUGINS.md).

## Stripe (no secrets in git)

Leave `STRIPE_SECRET_KEY` empty until ready. The UI shows **payments not configured** and disables checkout. Sessions are created **only** when the secret key is set.

| Option / env | Purpose |
|--------------|---------|
| `stripeSecretKey` / `STRIPE_SECRET_KEY` | Server Checkout Sessions (secret) |
| `stripePublishableKey` / `STRIPE_PUBLISHABLE_KEY` / `PUBLIC_STRIPE_PUBLISHABLE_KEY` | Client (reserved) |
| `stripeWebhookSecret` / `STRIPE_WEBHOOK_SECRET` | Webhooks (reserved) |
| `siteUrl` / `SITE_URL` | Success/cancel URLs |
| `stripePriceKit` / `STRIPE_PRICE_KIT` | One-time kit Price ID |
| `stripePricePublicIp` / `STRIPE_PRICE_PUBLIC_IP` | Public IP monthly Price ID |
| `stripePriceAirvpn` / `STRIPE_PRICE_AIRVPN` | AirVPN monthly Price ID |
| `stripePriceHermes` / `STRIPE_PRICE_HERMES` | Hermes monthly Price ID |
| `stripePriceBackups` / `STRIPE_PRICE_BACKUPS` | Backups monthly Price ID |

### Checkout modes

- **Hardware only** → `mode: payment` with the kit Price ID (rack/storage/shipping add-ons via `price_data`).
- **Any services** (services-only or kit + services) → `mode: subscription` with recurring Price IDs; if the cart includes the kit, the one-time kit Price ID is added to the same Checkout Session `line_items`.

Copy `app/.env.example` for local runs. **Never commit real `sk_` / `pk_` keys.**

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
| `/kit` | Configurator (rack / SSD / HDD, one-time CHF, CH shipping, month-end banner) |
| `/mini-pc` | Coming soon + interest email stub |
| `/services` | Monthly: public IP, AirVPN, Hermes tokens, backups |
| `/order` | Summary + Swiss address → Stripe Checkout when configured |
| `/order/thanks` | Confirmation |
| `/legal` | Impressum / privacy / AGB stubs |

Stack: lean **Express** Node app.

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

Paid hardware orders are intended for **month-end batch** shipping to CH addresses. Subscriptions renew monthly. Operational tooling is out of scope for this MVP.
