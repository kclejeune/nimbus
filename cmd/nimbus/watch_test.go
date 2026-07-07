package main

import "testing"

func TestIgnoredStoreName(t *testing.T) {
	ignored := []string{
		// Nix temp build dirs appear directly in the store and are not
		// store paths; feeding one to `nix-store --check-validity` fails
		// the whole batch with "too short to be a valid store path".
		"tmp-4994-1825064449",
		".links",
		".nfs00000123",
		"0007zb8m6xivj5lhn8lfigmz82d1g1mb-editline-1.17.1.drv",
		"0007zb8m6xivj5lhn8lfigmz82d1g1mb-editline-1.17.1.lock",
		"0007zb8m6xivj5lhn8lfigmz82d1g1mb-editline-1.17.1.tmp-123",
		"trash",
		"0007zb8m-too-short",
		"0007ZB8M6XIVJ5LHN8LFIGMZ82D1G1MB-upper-case",
	}
	kept := []string{
		"0007zb8m6xivj5lhn8lfigmz82d1g1mb-editline-1.17.1-unstable",
		"vlpbcrw7vgahfbvpsn0by27ahlx59m3f-cdc-test-1",
	}
	for _, name := range ignored {
		if !ignoredStoreName(name) {
			t.Errorf("ignoredStoreName(%q) = false, want true", name)
		}
	}
	for _, name := range kept {
		if ignoredStoreName(name) {
			t.Errorf("ignoredStoreName(%q) = true, want false", name)
		}
	}
}
