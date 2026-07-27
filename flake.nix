{
  description = "Nimbus - self-hosted Nix binary cache";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      forAllSystems = lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      # ./VERSION is the source of truth and the tag is cut from it, never the
      # reverse: a flake cannot see git tags at eval time (`self` exposes rev,
      # shortRev, lastModified and revCount — no tag), so tagging first would
      # leave the tag pointing at a commit that still claims the old version.
      #
      # The "-dev" suffix is what distinguishes main from a release. Dropping it
      # in a PR is the act that declares a release, so the commit a tag points
      # at is the only commit reporting a bare semver; everything after it on
      # main carries the next -dev version plus the rev it was built from.
      # .github/workflows/release-tag.yml owns both transitions.
      baseVersion = lib.fileContents ./VERSION;
      version =
        if lib.hasSuffix "-dev" baseVersion then
          "${baseVersion}+g${self.shortRev or self.dirtyShortRev or "dirty"}"
        else
          baseVersion;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          nimbus = pkgs.callPackage ./pkgs/nimbus {
            inherit version;
            src = self;
          };
          default = self.packages.${system}.nimbus;
        }
      );
    };
}
