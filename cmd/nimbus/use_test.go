package main

import (
	"os"
	"path/filepath"
	"slices"
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

func TestRemoveFromNixConf(t *testing.T) {
	tests := []struct {
		name        string
		initial     string
		removals    []confEdit
		want        string
		wantRemoved []string
	}{
		{
			name:    "remove one value keeps the others",
			initial: "extra-substituters = https://cache.nixos.org https://my.cache.example.com/mycache\n",
			removals: []confEdit{
				{key: "extra-substituters", value: "https://my.cache.example.com/mycache"},
			},
			want:        "extra-substituters = https://cache.nixos.org\n",
			wantRemoved: []string{"https://my.cache.example.com/mycache"},
		},
		{
			name:    "inline comment is preserved",
			initial: "extra-substituters = https://cache.nixos.org https://my.cache.example.com/mycache # managed by nixos\n",
			removals: []confEdit{
				{key: "extra-substituters", value: "https://my.cache.example.com/mycache"},
			},
			want:        "extra-substituters = https://cache.nixos.org # managed by nixos\n",
			wantRemoved: []string{"https://my.cache.example.com/mycache"},
		},
		{
			name:    "line dropped when its list empties",
			initial: "extra-substituters = https://my.cache.example.com/mycache\nextra-trusted-public-keys = mycache:abc=\n",
			removals: []confEdit{
				{key: "extra-substituters", value: "https://my.cache.example.com/mycache"},
				{key: "extra-trusted-public-keys", value: "mycache:abc="},
			},
			want:        "",
			wantRemoved: []string{"https://my.cache.example.com/mycache", "mycache:abc="},
		},
		{
			name:    "emptied line with comment keeps the comment",
			initial: "extra-substituters = https://my.cache.example.com/mycache # managed by nimbus\n",
			removals: []confEdit{
				{key: "extra-substituters", value: "https://my.cache.example.com/mycache"},
			},
			want:        "extra-substituters = # managed by nimbus\n",
			wantRemoved: []string{"https://my.cache.example.com/mycache"},
		},
		{
			name:    "value inside a comment is not removed",
			initial: "extra-substituters = https://cache.nixos.org # https://my.cache.example.com/mycache\n",
			removals: []confEdit{
				{key: "extra-substituters", value: "https://my.cache.example.com/mycache"},
			},
			want:        "extra-substituters = https://cache.nixos.org # https://my.cache.example.com/mycache\n",
			wantRemoved: nil,
		},
		{
			name:    "other keys and non-key lines untouched",
			initial: "# a comment line\nexperimental-features = nix-command flakes\nextra-substituters = https://my.cache.example.com/mycache https://other.example.com\n",
			removals: []confEdit{
				{key: "extra-substituters", value: "https://my.cache.example.com/mycache"},
			},
			want:        "# a comment line\nexperimental-features = nix-command flakes\nextra-substituters = https://other.example.com\n",
			wantRemoved: []string{"https://my.cache.example.com/mycache"},
		},
		{
			name:        "nothing to remove leaves the file alone",
			initial:     "extra-substituters = https://cache.nixos.org\n",
			removals:    []confEdit{{key: "extra-substituters", value: "https://gone.example.com"}},
			want:        "extra-substituters = https://cache.nixos.org\n",
			wantRemoved: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "nix.conf")
			if err := os.WriteFile(path, []byte(tc.initial), 0o644); err != nil {
				t.Fatal(err)
			}
			removed, err := removeFromNixConf(path, tc.removals)
			if err != nil {
				t.Fatalf("removeFromNixConf: %v", err)
			}
			if !slices.Equal(removed, tc.wantRemoved) {
				t.Errorf("removed = %v, want %v", removed, tc.wantRemoved)
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

func TestRemoveFromNixConfMissingFile(t *testing.T) {
	removed, err := removeFromNixConf(
		filepath.Join(t.TempDir(), "nix.conf"),
		[]confEdit{{key: "extra-substituters", value: "x"}},
	)
	if err != nil || removed != nil {
		t.Errorf("missing file: removed = %v, err = %v", removed, err)
	}
}

func TestNixConfValues(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nix.conf")
	initial := "substituters = https://cache.nixos.org\n" +
		"extra-substituters = https://a.example.com https://b.example.com # https://c.example.com\n"
	if err := os.WriteFile(path, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}
	got := nixConfValues(path, "extra-substituters")
	want := []string{"https://a.example.com", "https://b.example.com"}
	if !slices.Equal(got, want) {
		t.Errorf("nixConfValues = %v, want %v", got, want)
	}
	if got := nixConfValues(path, "missing-key"); got != nil {
		t.Errorf("missing key: %v", got)
	}
	if got := nixConfValues(filepath.Join(dir, "nope"), "substituters"); got != nil {
		t.Errorf("missing file: %v", got)
	}
}

func TestRemoveNetrc(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "netrc")
	initial := "machine keep.example.com password aaa\nmachine gone.example.com password bbb\n"
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}

	removed, err := removeNetrc(path, "gone.example.com")
	if err != nil || !removed {
		t.Fatalf("removeNetrc: removed = %v, err = %v", removed, err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "machine keep.example.com password aaa\n" {
		t.Errorf("got:\n%s", got)
	}

	// Absent entries and missing files are not errors.
	if removed, err := removeNetrc(path, "gone.example.com"); err != nil || removed {
		t.Errorf("second removal: %v, %v", removed, err)
	}
	if removed, err := removeNetrc(filepath.Join(dir, "nope"), "x"); err != nil || removed {
		t.Errorf("missing file: %v, %v", removed, err)
	}
}

func TestSubstituterHostInUse(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nix.conf")
	initial := "substituters = https://cache.nixos.org\n" +
		"extra-substituters = https://my.cache.example.com/other\n"
	if err := os.WriteFile(path, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}
	if !substituterHostInUse(path, "my.cache.example.com") {
		t.Error("expected host in use via extra-substituters")
	}
	if !substituterHostInUse(path, "cache.nixos.org") {
		t.Error("expected host in use via substituters")
	}
	if substituterHostInUse(path, "unused.example.com") {
		t.Error("expected host not in use")
	}
}
