import Foundation
import CryptoKit

@main struct FoundationChecks {
    static func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
        if !value() { throw LocalError.message(message) }
    }
    @MainActor static func main() async throws {
        let memory = "Legacy 🧠 notes\r\n\r\n## Decision one\r\nKeep café.\r\n\r\n## Decision two\r\nOther notes."
        let document = NativeMemoryDocument(memory)
        try expect(document.entries.count == 2 && document.body(-1) == "Legacy 🧠 notes", "Memory headings or legacy prefix changed")
        let changed = document.replacingBody(0, with: "Changed notes.")
        try expect(changed == memory.replacingOccurrences(of: "Keep café.", with: "Changed notes."), "Editing one memory changed other text")
        try expect(document.replacingBody(0, with: document.body(0)) == memory, "Unchanged memory was reserialized")
        try expect(NativeMemoryDocument("No headings 🧠").body(-1) == "No headings 🧠", "Legacy memory lost text")
        let longMemory = "## Long memory\n" + String(repeating: "Project fact. ", count: 2000)
        try expect(NativeMemoryDocument(longMemory).body(0).count == longMemory.count - "## Long memory\n".count, "Long memory shortened")
        let value = try JSONDecoder().decode(JSON.self, from: Data(#"{"zero":0,"false":false,"unknown":null}"#.utf8))
        try expect(value["zero"].number == 0 && value["false"].bool == false && value["unknown"].number == nil, "JSON values changed")
        let link = "http://127.0.0.1:4317/setup?token=" + String(repeating: "a", count: 64)
        let origin = try LocalBoundary.setupURL(link)
        try expect(!LocalBoundary.sameOrigin(URL(string: "http://127.0.0.1:4318")!, origin), "Origin guard failed")
        for path in ["/api/../../setup", "/api/%2e%2e/setup", "/api/x#bad"] {
            do { _ = try LocalBoundary.apiURL(path, origin: origin); throw LocalError.message("Path guard failed") }
            catch LocalError.message(let text) { try expect(text != "Path guard failed", text) }
        }
        let runtime = LocalRuntime()
        let first = Task { try await runtime.performMutation { try await Task.sleep(for: .milliseconds(80)); return 1 } }
        await Task.yield()
        try expect(runtime.mutationRunning, "Mutation gate did not hold")
        do { _ = try await runtime.performMutation { 2 }; throw LocalError.message("Overlap admitted") }
        catch LocalError.message(let text) { try expect(text != "Overlap admitted", text) }
        let result = try await first.value
        try expect(result == 1 && !runtime.mutationRunning, "Mutation gate did not release")
        let client = AgentKlarClient(runtime: runtime)
        client.adoptOnboarding(.object(["revision": .number(3)]))
        client.adoptOnboarding(.object(["revision": .number(2)]))
        try expect(client.onboarding["revision"].number == 3, "Preferences regressed")
        try expect(AgentKlarClient.requestTimeout("/projects/id/skills/preview") == 135 && AgentKlarClient.requestTimeout("/projects/id/native-settings/claude") == 60 && AgentKlarClient.requestTimeout("/snapshot") == 20, "Native operation request budgets changed")
        client.busy = true
        await client.updateService()
        try expect(client.error == "Finish the current local change before updating." && !runtime.mutationRunning, "An update overlapped a local change")
        client.busy = false
        try expect(client.maintenanceReady, "Maintenance gate stayed closed after local change")
        client.snapshot = JSON.any(["projects": [["id": "a", "name": "Alpha"], ["id": "b", "name": "Beta"]],
                                    "runs": [["id": "run-a", "projectId": "a"], ["id": "run-b", "projectId": "b"]]])
        let alpha = client.workspace(for: "a"), beta = client.workspace(for: "b")
        client.projectID = "b"
        try expect(alpha.projectID == "a" && beta.projectID == "b" && alpha.runtime === beta.runtime, "Workspace identity or shared runtime changed")
        try expect(alpha.runs.compactMap { $0["id"].string } == ["run-a"] && beta.runs.compactMap { $0["id"].string } == ["run-b"], "Workspace run data mixed")
        client.snapshot = JSON.any(["projects": [["id": "a", "name": "Renamed Alpha"], ["id": "b", "name": "Beta"]],
                                    "runs": [["id": "new-b", "projectId": "b"]]])
        try expect(alpha.project["name"].string == "Renamed Alpha" && alpha.runs.isEmpty && beta.runs.first?["id"].string == "new-b", "Workspace snapshots stopped following the parent")
        alpha.requestedRunID = "run-a"
        try expect(beta.requestedRunID == nil && client.requestedRunID == nil, "Task navigation crossed workspaces")
        beta.requestedRunID = "new-b"; alpha.requestedRunID = nil
        try expect(beta.requestedRunID == "new-b", "Clearing one workspace changed another task selection")
        alpha.reportError("Missing task")
        try expect(client.error == "Missing task" && beta.error == "Missing task", "Workspace errors were hidden from the shared banner")
        beta.reportError("")
        try expect(client.error.isEmpty && alpha.error.isEmpty, "Workspace error dismissal stayed local")
        alpha.adoptOnboarding(JSON.any(["revision": 4, "mainHarness": "claude"]))
        beta.adoptOnboarding(JSON.any(["revision": 3, "mainHarness": "codex"]))
        try expect(client.onboarding["revision"].number == 4 && alpha.onboarding == client.onboarding && beta.onboarding == client.onboarding, "Scoped preference adoption regressed")
        client.busy = true
        try expect(!alpha.maintenanceReady && !beta.maintenanceReady, "Scoped busy gate was bypassed")
        await beta.updateService()
        try expect(client.error == "Finish the current local change before updating." && !runtime.mutationRunning, "Scoped update bypassed the shared gate")
        client.busy = false
        try await runtime.performMutation {
            try expect(!alpha.maintenanceReady && !beta.maintenanceReady, "Scoped runtime gate was bypassed")
            await alpha.updateService()
            try expect(client.error == "Finish the current local change before updating.", "Scoped maintenance did not use the parent gate")
        }
        try expect(alpha.maintenanceReady && beta.maintenanceReady, "Scoped gate failed to reopen")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let resources = directory.appendingPathComponent("Resources"), cache = directory.appendingPathComponent("private-runtimes")
        let bundle = resources.appendingPathComponent("runtime")
        var hashes: [String: String] = [:]
        func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
        for path in ["bin/node", "agentklar/bin/agentklar.mjs", "agentklar/dist/server/server.js", "agentklar/empty"] {
            let file = bundle.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let bytes = Data((path == "agentklar/empty" ? "" : "fixture " + path).utf8)
            try bytes.write(to: file); hashes[path] = sha(bytes)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundle.appendingPathComponent("bin/node").path)
        let manifest = try JSONSerialization.data(withJSONObject: ["version": "0.1.0-beta.33", "nodeVersion": "24.21.0", "dataCompatibility": 1, "files": hashes], options: [.sortedKeys])
        try manifest.write(to: resources.appendingPathComponent("runtime-manifest.json"))
        let copied = try BundledRuntime.prepare(resources: resources, cache: cache, expectedHash: sha(manifest))
        try expect(copied.lastPathComponent == sha(manifest), "Runtime identity was not content-addressed")
        let reused = try BundledRuntime.prepare(resources: resources, cache: cache, expectedHash: sha(manifest))
        try expect(reused == copied, "Unchanged private runtime was not reused")
        try Data("changed".utf8).write(to: copied.appendingPathComponent("agentklar/bin/agentklar.mjs"))
        do {
            _ = try BundledRuntime.prepare(resources: resources, cache: cache, expectedHash: sha(manifest))
            throw LocalError.message("Changed private runtime admitted")
        } catch LocalError.message(let text) { try expect(text != "Changed private runtime admitted", text) }
        try FileManager.default.removeItem(at: copied)
        let nodeFile = bundle.appendingPathComponent("bin/node")
        try FileManager.default.removeItem(at: nodeFile)
        try FileManager.default.createSymbolicLink(at: nodeFile, withDestinationURL: URL(fileURLWithPath: "/bin/sh"))
        do {
            _ = try BundledRuntime.prepare(resources: resources, cache: cache, expectedHash: sha(manifest))
            throw LocalError.message("Linked runtime admitted")
        } catch LocalError.message(let text) { try expect(text != "Linked runtime admitted", text) }
        let script = directory.appendingPathComponent("fixture.sh")
        try Data("sleep 30 &\necho $! > child.pid\nprintf done\nexit 0\n".utf8).write(to: script)
        let started = Date()
        let output = try await LocalRuntime.command(URL(fileURLWithPath: "/bin/sh"), args: [script.path], environment: ["PATH": "/usr/bin:/bin"], cwd: directory, timeout: 2)
        try expect(output == "done" && Date().timeIntervalSince(started) < 3, "Retained pipes blocked completion")
        let child = Int32(try String(contentsOf: directory.appendingPathComponent("child.pid"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))!
        try expect(kill(child, 0) == -1, "Descendant survived completion")
        do {
            _ = try await LocalRuntime.command(URL(fileURLWithPath: "/bin/sh"), args: ["-c", "sleep 30"], environment: ["PATH": "/usr/bin:/bin"], cwd: directory, timeout: 0.1)
            throw LocalError.message("Timeout admitted")
        } catch LocalError.message(let text) { try expect(text != "Timeout admitted", text) }
        do {
            _ = try await LocalRuntime.command(URL(fileURLWithPath: "/bin/sh"), args: ["-c", "yes x"], environment: ["PATH": "/usr/bin:/bin"], cwd: directory, timeout: 2)
            throw LocalError.message("Output overflow admitted")
        } catch LocalError.message(let text) { try expect(text != "Output overflow admitted", text) }
        print("Foundation checks passed: JSON, origin/path, mutation gate, CAS freshness, scoped projects/navigation/shared gates, bundled copy/tamper/symlink, descendant cleanup, timeout, output limit.")
    }
}
