import { lstatSync, realpathSync, type BigIntStats } from "node:fs";

export function rootStamp(st: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">) {
  // A new directory can reuse an inode. Without birth time, refuse guarded writes.
  if (st.birthtimeNs <= 0n) throw new Error("Project folder creation time is unavailable.");
  return `v2:${st.dev}:${st.ino}:${st.birthtimeNs}`;
}

export function projectRootIdentity(path: string) {
  const st = lstatSync(path, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Project folder changed.");
  return rootStamp(st);
}
