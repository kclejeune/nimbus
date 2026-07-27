# The nimbus CLI. `src` and `version` come from the flake so this file stays a
# plain callPackage expression — and so `nix-update --flake --version=skip
# nimbus` has a single file to rewrite when a go.mod bump changes the vendored
# module set (.github/workflows/vendor-hash.yml does exactly that in CI).
{
  buildGoModule,
  src,
  version ? "dev",
}:

buildGoModule {
  pname = "nimbus";
  inherit src version;

  vendorHash = "sha256-Zxytm0q+2ruJR0YpJMzlCECj7ZBN54xp3EQ7rz3mVoc=";

  subPackages = [ "cmd/nimbus" ];
  env.CGO_ENABLED = 0;
  ldflags = [
    "-s"
    "-w"
    "-X main.version=${version}"
  ];

  meta.mainProgram = "nimbus";
}
