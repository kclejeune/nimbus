package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEditNixConf(t *testing.T) {
	tests := []struct {
		name    string
		initial string
		edits   []confEdit
		want    string
	}{
		{
			name:    "append to line with inline comment",
			initial: "extra-substituters = https://cache.nixos.org # managed by nixos\n",
			edits:   []confEdit{{key: "extra-substituters", value: "https://my.cache.example.com"}},
			want:    "extra-substituters = https://cache.nixos.org https://my.cache.example.com # managed by nixos\n",
		},
		{
			name:    "idempotent rerun on fixed output",
			initial: "extra-substituters = https://cache.nixos.org https://my.cache.example.com # managed by nixos\n",
			edits:   []confEdit{{key: "extra-substituters", value: "https://my.cache.example.com"}},
			want:    "extra-substituters = https://cache.nixos.org https://my.cache.example.com # managed by nixos\n",
		},
		{
			name:    "value present only inside comment must still append",
			initial: "extra-substituters = https://cache.nixos.org # https://my.cache.example.com\n",
			edits:   []confEdit{{key: "extra-substituters", value: "https://my.cache.example.com"}},
			want:    "extra-substituters = https://cache.nixos.org https://my.cache.example.com # https://my.cache.example.com\n",
		},
		{
			name:    "replace preserves trailing comment",
			initial: "netrc-file = /old/path # managed by nimbus\n",
			edits:   []confEdit{{key: "netrc-file", value: "/new/path", replace: true}},
			want:    "netrc-file = /new/path # managed by nimbus\n",
		},
		{
			name:    "append to line without comment",
			initial: "extra-substituters = https://cache.nixos.org\n",
			edits:   []confEdit{{key: "extra-substituters", value: "https://my.cache.example.com"}},
			want:    "extra-substituters = https://cache.nixos.org https://my.cache.example.com\n",
		},
		{
			name:    "new key written when absent",
			initial: "",
			edits:   []confEdit{{key: "extra-substituters", value: "https://my.cache.example.com"}},
			want:    "extra-substituters = https://my.cache.example.com\n",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "nix.conf")
			if tc.initial != "" {
				if err := os.WriteFile(path, []byte(tc.initial), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if err := editNixConf(path, tc.edits); err != nil {
				t.Fatalf("editNixConf: %v", err)
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			if strings.TrimRight(string(got), "\n") != strings.TrimRight(tc.want, "\n") {
				t.Errorf("got:\n%s\nwant:\n%s", got, tc.want)
			}
		})
	}
}
