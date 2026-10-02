import Foundation

@main struct FoundationChecks {
    static func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
        if !value() { throw LocalError.message(message) }
    }
    @MainActor static func main() async throws {
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
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
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
        print("Foundation checks passed: JSON, origin/path, mutation gate, CAS freshness, descendant cleanup, timeout, output limit.")
    }
}
