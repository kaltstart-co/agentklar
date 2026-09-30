import { cp, mkdir, readdir, rm } from "node:fs/promises";
const target = new URL("../../internal/ui/frontend/", import.meta.url);
await mkdir(target, { recursive: true });
for (const entry of await readdir(target)) {
  if (entry !== "BUILD_REQUIRED")
    await rm(new URL(entry, target), { recursive: true, force: true });
}
await cp(new URL("../dist/", import.meta.url), target, { recursive: true });
