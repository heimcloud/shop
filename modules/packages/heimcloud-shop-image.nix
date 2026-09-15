# Expose heimcloud-shop OCI image as flake package: nix build .#heimcloud-shop
{...}: {
  perSystem = {pkgs, ...}: let
    heimcloud-shop = pkgs.callPackage ../../package.nix {};
  in {
    packages = {
      inherit heimcloud-shop;
      default = heimcloud-shop;
    };
  };
}
