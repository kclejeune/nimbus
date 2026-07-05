# nimbus CLI

Go client for nimbus servers, mirroring the attic CLI:

```bash
nimbus login prod https://cache.example.com            # browser device-auth flow
nimbus login prod https://cache.example.com <token>    # or paste a token
nimbus cache create mycache --public --compression zstd
nimbus use mycache                                     # wire up nix.conf (+ netrc if private)
nimbus push mycache ./result /nix/store/...            # closures, parallel, chunked >100MB
nimbus watch-store mycache                             # push new store paths as they appear
nimbus cache info|configure|rename|destroy mycache
```

Caches are addressed as `[server:]cache`; the first login becomes the default
server. Config lives at `~/.config/nimbus/config.toml` (XDG respected).

Pushes query the closure via `nix path-info`, skip paths the server already
has (or can fetch from its upstreams), and upload raw NARs for the server to
compress — except >100MB NARs, which are zstd-compressed client-side and
uploaded through the chunked protocol.

## Development

```bash
mise run check    # lint + test + build (binary at build/nimbus)
```
