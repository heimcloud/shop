# Shop service options — Heimcloud Swiss storefront.
{...}: {
  flake.modules.nixos.shop-option = {
    config,
    lib,
    ...
  }:
    with lib;
    with {inherit (lib.neo) mkOption mkEnableOption;}; {
      options.neo.services.shop = mkOption {
        type = types.submodule {
          options =
            {
              enabled = mkEnableOption "Heimcloud shop storefront" {rank = 0;};
              stripeSecretKey = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Stripe secret key (sk_…). Prefer injecting via secrets; leave null until configured.";
              };
              stripePublishableKey = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Stripe publishable key (pk_…).";
              };
              stripeWebhookSecret = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Stripe webhook signing secret (whsec_…) for POST /api/stripe/webhook.";
              };
              siteUrl = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Public site URL for Stripe redirects (e.g. https://shop.example.com).";
              };
              # Price IDs are not secrets — Test defaults match Stripe catalog.
              stripePriceKit = mkOption {
                type = types.str;
                default = "price_1UFvgv1oIIxcEEBR67p9pqaf";
                description = "Stripe Price ID for ZimaBlade kit (one-time).";
              };
              stripePricePublicIp = mkOption {
                type = types.str;
                default = "price_1UFviO1oIIxcEEBRE6vE1O4L";
                description = "Stripe Price ID for Public IP (monthly).";
              };
              stripePriceAirvpn = mkOption {
                type = types.str;
                default = "price_1UFvjR1oIIxcEEBR8aHsaXaA";
                description = "Stripe Price ID for AirVPN (monthly).";
              };
              stripePriceHermes = mkOption {
                type = types.str;
                default = "price_1UFvke1oIIxcEEBR2ZyLrPyV";
                description = "Stripe Price ID for Hermes AI tokens (monthly).";
              };
              stripePriceBackups = mkOption {
                type = types.str;
                default = "price_1UFvmL1oIIxcEEBRAVZNH5s7";
                description = "Stripe Price ID for Backups (monthly).";
              };
              # Admin UI — storefront stays public; Tinyauth only on admin paths (swag.nix).
              admin = mkOption {
                type = types.submodule {
                  options = {
                    enabled = mkOption {
                      type = types.bool;
                      default = true;
                      description = "Enable in-app admin UI (ADMIN_ENABLED). When false, admin routes return 404.";
                      rank = 0;
                    };
                    path = mkOption {
                      type = types.str;
                      default = "/admin";
                      description = "Admin URL path with no trailing slash (ADMIN_PATH). Default /admin.";
                      rank = 10;
                    };
                    auth = mkOption {
                      type = types.bool;
                      default = true;
                      description = "When true (and Tinyauth is enabled), SWAG Tinyauth-protects admin locations and /api/admin. Does not lock the public storefront.";
                      rank = 20;
                    };
                    readOnly = mkOption {
                      type = types.bool;
                      default = false;
                      description = "Disable mutating admin forms (ADMIN_READ_ONLY). Cancels / edits become no-ops with 403.";
                      rank = 30;
                    };
                  };
                };
                default = {};
                description = "Admin UI for customers, orders, entitlements, and provisioning jobs. Gated by Tinyauth at the Neo reverse-proxy edge when admin.auth is true; the storefront remains public (auth.enabled stays false).";
                rank = 10;
              };
            }
            // lib.neo.mkReverseProxyOptions {
              subdomain = "shop";
              auth.enabled = false;
            }
            // lib.neo.mkVpnOptions {
              containers = ["shop"];
              networks = ["internal"];
              ports = [3000];
            }
            // lib.neo.mkContainerDefinitions {
              # Tag name for the Nix-built image (imageFile always loads package.nix).
              shop = "heimcloud-shop:latest";
            }
            // lib.neo.mkAppdata "${config.neo.core.volumes.appdata}/shop"
            // lib.neo.mkServiceMeta {
              category = "Commerce/Shop";
              description = ''
                Heimcloud Swiss storefront — ZimaBlade / NAS kits, CHF only,
                month-end batch fulfillment. Public reverse proxy (auth off),
                like portrait. Admin UI at /admin is Tinyauth-gated when
                admin.auth is true. SQLite (WAL) at appdata/shop/shop.sqlite
                (/data in container); set stripeWebhookSecret for webhooks.
              '';
              projectUrl = "https://github.com/heimcloud/shop";
              githubUrl = "https://github.com/heimcloud/shop";
            };
        };
        default = {};
        description = "Heimcloud shop service configuration";
      };
    };
}
