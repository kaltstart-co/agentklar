package quality

import "testing"

func TestConfig_Select(t *testing.T) {
	tests := []struct {
		name         string
		config       Config
		changedPaths []string
		maxLevel     string
		want         []string
	}{
		{
			name:         "recipe with no scopes matches regardless of changed paths",
			config:       Config{Recipes: []Recipe{{Name: "test1", Command: "cmd1"}}},
			changedPaths: []string{"any/path"},
			maxLevel:     "L1",
			want:         []string{"test1"},
		},
		{
			name:         "recipe with scopes matches only when a changed path has that prefix",
			config:       Config{Recipes: []Recipe{{Name: "test1", Command: "cmd1", Scopes: []string{"src/"}}}},
			changedPaths: []string{"src/main.go"},
			maxLevel:     "L1",
			want:         []string{"test1"},
		},
		{
			name:         "scoped recipe does not match a non-matching path",
			config:       Config{Recipes: []Recipe{{Name: "test1", Command: "cmd1", Scopes: []string{"src/"}}}},
			changedPaths: []string{"docs/readme.md"},
			maxLevel:     "L1",
			want:         nil,
		},
		{
			name:         "maxLevel filters out higher levels",
			config:       Config{Recipes: []Recipe{{Name: "l1", Command: "cmd1", Level: "L1"}, {Name: "l2", Command: "cmd2", Level: "L2"}}},
			changedPaths: []string{"any/path"},
			maxLevel:     "L1",
			want:         []string{"l1"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.config.Select(tt.changedPaths, tt.maxLevel)
			if len(got) != len(tt.want) {
				t.Fatalf("Select() got %d recipes, want %d", len(got), len(tt.want))
			}
			for i := range got {
				if got[i].Name != tt.want[i] {
					t.Errorf("Select() recipe %d = %v, want %v", i, got[i].Name, tt.want[i])
				}
			}
		})
	}
}
