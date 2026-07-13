-- Upstreams that ship in every Nix installation's default config
-- (substituters + trusted-public-keys) are omitted from the generated
-- nix.conf snippets — listing them again is noise. Admin-editable flag, not
-- hardcoded; cache.nixos.org is the obvious seed.
ALTER TABLE upstream ADD COLUMN nix_default INTEGER NOT NULL DEFAULT 0;
UPDATE upstream SET nix_default = 1 WHERE url = 'https://cache.nixos.org';
