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
                description = "Stripe webhook signing secret (whsec_…).";
              };
              siteUrl = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Public site URL for Stripe redirects (e.g. https://shop.example.com).";
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
              # Build locally: docker build -t heimcloud/shop:latest .
              # Or push to GHCR and switch to ghcr.io/heimcloud/shop:latest
              shop = "heimcloud/shop:latest";
            }
            // lib.neo.mkAppdata "${config.neo.core.volumes.appdata}/shop"
            // lib.neo.mkServiceMeta {
              category = "Commerce/Shop";
              description = ''
                Heimcloud Swiss storefront — ZimaBlade / NAS kits, CHF only,
                month-end batch fulfillment. Public reverse proxy (auth off),
                like portrait.
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
