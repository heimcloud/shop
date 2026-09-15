# Shop service implementation — OCI container.
{...}: {
  flake.modules.nixos.shop = {
    config,
    lib,
    ...
  }:
    with lib; let
      cfg = config.neo.services.shop;
      # Dockerfile: addgroup -S shop && adduser -S shop -G shop → uid 100 / gid 101
      # (Alpine reserves gid 100 for `users`). Must match image USER for SQLite on /data.
      shopUid = "100";
      shopGid = "101";
      shopAppdata = "${config.neo.core.volumes.appdata}/shop";
      adminPath = let
        p = cfg.admin.path or "/admin";
      in
        if lib.hasSuffix "/" p && p != "/"
        then lib.removeSuffix "/" p
        else p;
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
        # Ensure host appdata (mounted at /data) is owned by the container user.
        # mkActivationScriptForDir only chowns on create; always re-align for existing dirs
        # (default neo.core.uid/gid is homeserver 1000, which causes SQLite CANTOPEN).
        systemd.services.docker-shop.preStart = lib.concatStringsSep "\n" [
          (lib.neo.mkActivationScriptForDir config {
            dirPath = shopAppdata;
            user = shopUid;
            group = shopGid;
          })
          "chown -R ${shopUid}:${shopGid} ${shopAppdata}"
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
              ADMIN_ENABLED =
                if cfg.admin.enabled
                then "true"
                else "false";
              ADMIN_PATH = adminPath;
              ADMIN_READ_ONLY =
                if cfg.admin.readOnly
                then "true"
                else "false";
            };
          image = cfg.containers.shop;
          autoStart = true;
          volumes = [
            "${shopAppdata}:/data"
          ];
          networks = ["internal"];
        };
      };
    };
}
