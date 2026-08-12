package ctx

import "testing"

func TestMemoryRefPreservesLegacyIdentity(t *testing.T) {
	if got := MemoryRef(42); got != "memory/42" {
		t.Fatalf("MemoryRef(42) = %q, want memory/42", got)
	}
}
