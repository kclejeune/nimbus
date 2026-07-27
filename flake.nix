{
  description = "Nimbus - self-hosted Nix binary cache";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          version = self.shortRev or self.dirtyShortRev or "dev";
        in
        {
          nimbus = pkgs.buildGoModule {
            pname = "nimbus";
            inherit version;
            src = self;
            vendorHash = "sha256-Zxytm0q+2ruJR0YpJMzlCECj7ZBN54xp3EQ7rz3mVoc=";
            subPackages = [ "cmd/nimbus" ];
            env.CGO_ENABLED = 0;
            ldflags = [
              "-s"
              "-w"
              "-X main.version=${version}"
            ];
            meta.mainProgram = "nimbus";
          };
          default = self.packages.${system}.nimbus;
        }
      );
    };
}
