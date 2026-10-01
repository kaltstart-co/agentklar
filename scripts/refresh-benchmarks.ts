// Explicit developer refresh. New releases require reviewing src/benchmarks.ts first.
import { writeFileSync } from "node:fs";
import { BenchmarkCache } from "../src/benchmarks.ts";
const snapshot = await new BenchmarkCache().refresh();
writeFileSync(new URL("../src/benchmark-snapshot.ts", import.meta.url), `// LiveBench public data. Attribution: https://livebench.ai/\n// Data license: Apache-2.0; https://github.com/LiveBench/LiveBench/blob/main/docs/DATASHEET.md\nexport const bundledBenchmarks = ${JSON.stringify(snapshot, null, 2)} as const;\n`);
