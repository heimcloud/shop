# Shop service implementation — OCI container.
{...}: {
  flake.modules.nixos.shop = {
    config,
    lib,
    ...
  }:
    with lib; let
      cfg = config.neo.services.shop;
      stripeEnv = lib.filterAttrs (_: v: v != null && v != "") {
        STRIPE_SECRET_KEY = cfg.stripeSecretKey;
        STRIPE_PUBLISHABLE_KEY = cfg.stripePublishableKey;
        PUBLIC_STRIPE_PUBLISHABLE_KEY = cfg.stripePublishableKey;
        STRIPE_WEBHOOK_SECRET = cfg.stripeWebhookSecret;
        SITE_URL = cfg.siteUrl;
        STRIPE_PRICE_KIT = cfg.stripePriceKit;
        STRIPE_PRICE_PUBLIC_IP = cfg.stripePricePublicIp;
        STRIPE_PRICE_AIRVPN = cfg.stripePriceAirvpn;
        STRIPE_PRICE_HERMES = cfg.stripePriceHermes;
        STRIPE_PRICE_BACKUPS = cfg.stripePriceBackups;
      };
    in {
      config = mkIf cfg.enabled {
        systemd.services.docker-shop.preStart = lib.concatStringsSep "\n" [
          (lib.neo.mkActivationScriptForDir config {
            dirPath = "${config.neo.core.volumes.appdata}/shop";
          })
        ];

        virtualisation.oci-containers.containers.shop = {
          environment =
            stripeEnv
            // {
              TZ = "Europe/Zurich";
              PORT = "3000";
              NODE_ENV = "production";
              # SQLite WAL file lives on Neo appdata volume (host: …/appdata/shop/shop.sqlite)
              SHOP_DB_PATH = "/data/shop.sqlite";
            };
          image = cfg.containers.shop;
          autoStart = true;
          volumes = [
            "${config.neo.core.volumes.appdata}/shop:/data"
          ];
          networks = ["internal"];
        };
      };
    };
}
