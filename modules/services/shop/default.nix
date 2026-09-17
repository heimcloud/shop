# Shop service implementation — OCI container from flake dockerTools image.
{...}: {
  flake.modules.nixos.shop = {
    config,
    lib,
    pkgs,
    ...
  }:
    with lib; let
      cfg = config.neo.services.shop;
      shopAppdata = "${config.neo.core.volumes.appdata}/shop";
      shopImage = pkgs.callPackage ../../../package.nix {};
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
        PROVISIONING_API_TOKEN = cfg.provisioningApiToken;
        ACCOUNT_SESSION_SECRET = cfg.accountSessionSecret;
        GITEA_BASE_URL = cfg.giteaBaseUrl;
        SITE_URL = cfg.siteUrl;
        STRIPE_PRICE_KIT = cfg.stripePriceKit;
        STRIPE_PRICE_PUBLIC_IP = cfg.stripePricePublicIp;
        STRIPE_PRICE_AIRVPN = cfg.stripePriceAirvpn;
        STRIPE_PRICE_HERMES = cfg.stripePriceHermes;
        STRIPE_PRICE_BACKUPS = cfg.stripePriceBackups;
      };
    in {
      config = mkIf cfg.enabled {
        # Appdata owned by neo.core.uid/gid (same as container user).
        systemd.services.docker-shop.preStart = lib.neo.mkEnsureDirs config [shopAppdata];

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
          imageFile = shopImage;
          user = "${toString config.neo.core.uid}:${toString config.neo.core.gid}";
          autoStart = true;
          volumes = [
            "${shopAppdata}:/data"
          ];
          networks = ["internal"];
        };
      };
    };
}
