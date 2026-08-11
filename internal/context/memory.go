package ctx

import "strconv"

// MemoryRef preserves the context identity used by full memory reindexes.
func MemoryRef(id int64) string { return "memory/" + strconv.FormatInt(id, 10) }
