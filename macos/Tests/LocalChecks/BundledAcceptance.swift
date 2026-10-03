import Foundation

@main struct BundledAcceptance {
    static func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
        if !value() { throw LocalError.message(message) }
    }
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4, ["first", "reopen"].contains(args[3]) else { throw LocalError.message("Expected app path, private home, and phase") }
        let app = URL(fileURLWithPath: args[1]), home = URL(fileURLWithPath: args[2])
        let infoData = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        let info = try PropertyListSerialization.propertyList(from: infoData, format: nil) as! [String: Any]
        let expected = info["AgentKlarRuntimeManifestSHA256"] as? String
        guard expected != nil else { throw LocalError.message("Packaged app lacks trusted runtime hash") }
        let runtime = LocalRuntime(home: home, environment: ProcessInfo.processInfo.environment,
                                   resources: app.appendingPathComponent("Contents/Resources"), manifestHash: expected)
        try await runtime.discover()
        try expect(runtime.isBundledRuntime, "Runtime did not come from app")
        let launcher = runtime.launcher!
        try expect(launcher.path.hasPrefix(home.path + "/Library/Application Support/AgentKlar/runtimes/"), "Runtime escaped private cache")
        let version = try await runtime.runCLI(["--version"])
        guard let appVersion = info["AgentKlarReleaseVersion"] as? String else { throw LocalError.message("App release version is missing") }
        try expect(version.trimmingCharacters(in: .whitespacesAndNewlines) == appVersion, "Copied CLI version differs from app version")
        let before = try await runtime.runCLI(["service", "status"])
        if args[3] == "first" { try expect(before.trimmingCharacters(in: .whitespacesAndNewlines) == "AgentKlar background startup is not installed.", "First launch reused an install") }
        else { try expect(LocalBoundary.idleService(before), "Reopen did not preserve idle managed service") }
        let client = AgentKlarClient(runtime: runtime)
        await client.connect()
        try expect(client.connected && client.hasLoadedWorkspace, "Native connection failed: " + client.error)
        try expect(client.runs.isEmpty, "Acceptance unexpectedly started workers")
        let updateStatus = try await client.request("/update")
        try expect(updateStatus["current"].string == appVersion, "Connected service version differs from app version")
        let fixture = home.appendingPathComponent("fixture-project")
        if args[3] == "first" {
            _ = try await client.request("/projects", body: ["name": "Standalone acceptance", "path": fixture.path])
        }
        let snapshot = try await client.request("/snapshot")
        try expect((snapshot["projects"].array ?? []).contains { $0["path"].string == fixture.path }, "Saved fixture did not survive reopen")
        let after = try await runtime.runCLI(["service", "status"])
        try expect(LocalBoundary.idleService(after), "Service is not idle")
        let report: [String: Any] = ["phase": args[3], "runtimeVersion": version.trimmingCharacters(in: .whitespacesAndNewlines), "connected": client.connected, "launcher": launcher.path, "workersStarted": 0, "serviceVersion": updateStatus["current"].string ?? "unknown"]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    }
}
