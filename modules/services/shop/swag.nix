# Shop reverse proxy for SWAG.
# Storefront stays public (auth.enabled = false on reverse-proxy options).
# When admin.enabled && admin.auth && tinyauth is enabled, only admin paths
# and /api/admin get Tinyauth (same snippets as lib.neo.authBlock / authLocations).
# Webhook POST /api/stripe/webhook stays under unauthenticated location /.
# Customer portal /account (magic-link) also stays public — only /admin is Tinyauth.
{...}: {
  flake.modules.nixos.shop-swag = {
    config,
    lib,
    ...
  }: let
    cfg = config.neo.services.shop;
    tinyauthCfg = config.neo.services.tinyauth or {enabled = false;};
    adminPathRaw = cfg.admin.path or "/admin";
    adminPath =
      if lib.hasSuffix "/" adminPathRaw && adminPathRaw != "/"
      then lib.removeSuffix "/" adminPathRaw
      else adminPathRaw;
    protectAdmin = cfg.admin.enabled && cfg.admin.auth && (tinyauthCfg.enabled or false);
    # authBlock / authLocations gate on cfg.auth.enabled — keep whole-site auth off,
    # but reuse the helpers with a patched cfg so admin locations get the same snippets.
    adminAuthCfg = cfg // {auth = (cfg.auth or {}) // {enabled = true;};};
    adminAuthBlock =
      if protectAdmin
      then lib.neo.authBlock config adminAuthCfg
      else "";
    adminAuthLocations =
      if protectAdmin
      then lib.neo.authLocations config adminAuthCfg
      else "";
    proxyUpstream = ''
          include /config/nginx/proxy.conf;
          include /config/nginx/resolver.conf;
          set $upstream_app shop;
          set $upstream_port 3000;
          set $upstream_proto http;
          proxy_pass $upstream_proto://$upstream_app:$upstream_port;'';
    adminLocations =
      if cfg.admin.enabled
      then ''

        location ${adminPath} {
          ${proxyUpstream}${adminAuthBlock}
        }

        location ${adminPath}/ {
          ${proxyUpstream}${adminAuthBlock}
        }

        location /api/admin {
          ${proxyUpstream}${adminAuthBlock}
        }
''
      else "";
  in {
    config.neo.services.shop.proxyConf = lib.mkDefault ''
      server {
        include /config/nginx/listen-https.conf;
        http2 on;
        server_name ${cfg.subdomain}.*;
        include /config/nginx/ssl.conf;
        include /config/nginx/geo-access.conf;
        client_max_body_size 0;
${adminLocations}
        location / {
          include /config/nginx/proxy.conf;
          include /config/nginx/resolver.conf;
          set $upstream_app shop;
          set $upstream_port 3000;
          set $upstream_proto http;
          proxy_pass $upstream_proto://$upstream_app:$upstream_port;
        }
        ${adminAuthLocations}
      }
    '';
  };
}
