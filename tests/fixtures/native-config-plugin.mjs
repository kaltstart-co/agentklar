import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2), home = process.env.CLAUDE_CONFIG_DIR, cwd = process.cwd();
const mode = () => readFileSync(process.env.NATIVE_CHANGE_MODE, "utf8");
appendFileSync(process.env.NATIVE_CHANGE_CALLS, JSON.stringify(args) + "\n");
const read = path => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
const save = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };
const fail = () => { process.stderr.write("PRIVATE_NATIVE_ERROR"); process.exit(1); };
const hash = text => createHash("sha256").update(text).digest("hex");
if (args[0] === "app-server") {
  const path = join(process.env.CODEX_HOME, "config.toml");
  createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (!request.id) return;
    appendFileSync(process.env.NATIVE_CHANGE_CALLS, request.method + "\n");
    let result = {};
    if (request.method === "config/read") {
      result = { layers: [{ name: { type: "user", file: path, profile: mode() === "profile" ? "other" : null }, version: hash(existsSync(path) ? readFileSync(path, "utf8") : ""), config: read(path) }] };
    }
    if (request.method === "config/value/write") {
      if (mode() === "write-before") return process.stdout.write(JSON.stringify({ id: request.id, error: { message: "PRIVATE_NATIVE_ERROR" } }) + "\n");
      const before = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (request.params.expectedVersion !== hash(before)) return process.stdout.write(JSON.stringify({ id: request.id, error: { message: "conflict" } }) + "\n");
      const data = read(path);
      if (request.params.value === null) delete data[request.params.keyPath]; else data[request.params.keyPath] = request.params.value;
      save(path, data);
      if (mode() === "write-after") return process.stdout.write(JSON.stringify({ id: request.id, error: { message: "PRIVATE_NATIVE_ERROR" } }) + "\n");
      result = { status: "ok", filePath: path, version: hash(readFileSync(path, "utf8")) };
    }
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  });
} else if (args[0] === "plugin") {
  const registry = join(home, "plugins/installed_plugins.json"), markets = join(home, "plugins/known_marketplaces.json"), config = join(cwd, ".claude/settings.local.json");
  const replaceMarketplace = (phase, marketplace) => {
    const target = mode().replace(`replace-${phase}-`, "");
    if (target === mode()) return;
    const external = { source: { source: "directory", path: "/externally-managed-marketplace" } };
    if (target === "registry") { const data = read(markets); data[marketplace] = external; save(markets, data); }
    else if (target === "local" || target === "user") {
      const path = target === "local" ? config : join(home, "settings.json"), settings = read(path);
      settings.extraKnownMarketplaces ??= {}; settings.extraKnownMarketplaces[marketplace] = external; save(path, settings);
    }
  };
  if (args.includes("--help")) { console.log("Usage: native plugin install --scope local --json"); process.exit(); }
  if (args[1] === "list") {
    if (mode() === "list-bad") console.log("not json"); else console.log(JSON.stringify(Object.values(read(registry))));
  } else if (args[1] === "validate") {
    const catalog = read(join(args[2], ".claude-plugin/marketplace.json"));
    if (!catalog.name || catalog.plugins.length !== 1) fail();
    console.log("Validation passed");
  } else if (args[1] === "marketplace") {
    const data = read(markets), settings = read(config);
    if (args[2] === "add") {
      const catalog = read(join(args[3], ".claude-plugin/marketplace.json"));
      if (data[catalog.name]) fail();
      data[catalog.name] = { source: { source: "directory", path: args[3] } };
      settings.extraKnownMarketplaces ??= {}; settings.extraKnownMarketplaces[catalog.name] = data[catalog.name];
    } else {
      if (mode() === "remove-before") fail();
      delete data[args[3]]; delete settings.extraKnownMarketplaces?.[args[3]];
    }
    save(markets, data); save(config, settings);
    if (args[2] === "add") replaceMarketplace("add", read(join(args[3], ".claude-plugin/marketplace.json")).name);
    console.log("Native marketplace command succeeded");
  } else if (args[1] === "install") {
    if (mode() === "install-before") fail();
    const id = args[2], [name, marketplace] = id.split("@"), source = read(markets)[marketplace].source.path;
    const manifest = read(join(source, "plugins", name, ".claude-plugin/plugin.json"));
    const installPath = join(home, "plugins/cache", marketplace, name, manifest.version);
    cpSync(join(source, "plugins", name), installPath, { recursive: true });
    const data = read(registry); data[id] = { id, version: manifest.version, scope: "local", enabled: true, installPath, projectPath: cwd };
    save(registry, data);
    const settings = read(config); settings.enabledPlugins ??= {}; settings.enabledPlugins[id] = true; save(config, settings);
    replaceMarketplace("install", marketplace);
    if (mode() === "install-after") fail();
    console.log(JSON.stringify({ command: "install", outcome: "ok", pluginId: id, scope: "local" }));
  } else if (args[1] === "details") {
    const row = Object.values(read(registry)).find(row => row.id.startsWith(args[2] + "@"));
    replaceMarketplace("details", row.id.split("@")[1]);
    console.log(`${row.id}\nSkills (1) agentklar-workflow\nAgents (0)\nHooks (${mode() === "details-bad" ? 1 : 0})\nMCP servers (0)`);
  } else if (args[1] === "uninstall") {
    const id = args[2], data = read(registry), settings = read(config);
    delete data[id]; delete settings.enabledPlugins?.[id]; save(registry, data); save(config, settings);
    replaceMarketplace("uninstall", id.split("@")[1]);
    if (mode() === "uninstall-after") fail();
    console.log(JSON.stringify({ command: "uninstall", outcome: "ok", pluginId: id, scope: "local" }));
  } else fail();
} else fail();
