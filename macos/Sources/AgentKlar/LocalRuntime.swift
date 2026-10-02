import Foundation
import Combine
import CryptoKit
import Darwin

enum LocalError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

enum LocalBoundary {
    static func setupURL(_ output: String) throws -> URL {
        let value = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: #"^http://127\.0\.0\.1:[1-9][0-9]{0,4}/setup\?token=[0-9a-f]{64}$"#, options: .regularExpression) != nil,
              let url = URL(string: value), let port = url.port, port >= 1024, port <= 65535 else {
            throw LocalError.message("The managed service did not return a valid private local link.")
        }
        return url
    }
    static func sameOrigin(_ url: URL, _ origin: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == origin.port
            && url.user == nil && url.password == nil && origin.scheme == "http" && origin.host == "127.0.0.1"
    }
    static func apiURL(_ path: String, origin: URL) throws -> URL {
        let path = path.hasPrefix("/api/") ? path : "/api" + (path.hasPrefix("/") ? path : "/" + path)
        guard path.count <= 4096, !path.contains("#"), !path.unicodeScalars.contains(where: { $0.value < 32 }),
              let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              sameOrigin(url, origin), url.path.hasPrefix("/api/"),
              !url.path.components(separatedBy: "/").contains(where: { $0 == "." || $0 == ".." }) else {
            throw LocalError.message("Only local AgentKlar API paths are supported.")
        }
        return url
    }
    static func idleService(_ output: String) -> Bool {
        output.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^Installed; running on http://127\.0\.0\.1:[0-9]+; 0 active run\(s\)\.$"#, options: .regularExpression) != nil
    }
    static func runningService(_ output: String) -> Bool {
        output.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^Installed; running on http://127\.0\.0\.1:[0-9]+; [0-9]+ active run\(s\)\.$"#, options: .regularExpression) != nil
    }
    static func safeError(_ text: String) -> String {
        if text.contains("Node 24") { return "The bundled runtime could not start. Reinstall a complete AgentKlar app, then reconnect." }
        if text.range(of: "active|busy|pending", options: [.regularExpression, .caseInsensitive]) != nil { return "Finish active work or pending changes before retrying." }
        if text.range(of: "paused|recovery|maintenance", options: [.regularExpression, .caseInsensitive]) != nil { return "AgentKlar is paused for recovery. Keep its saved recovery files and resolve the pending operation before retrying." }
        return "AgentKlar could not finish this step. Your existing service was kept. Reconnect, or use a complete AgentKlar app to repair its runtime."
    }
}

@MainActor final class LocalRuntime: ObservableObject {
    @Published private(set) var mutationRunning = false
    private(set) var launcher: URL?
    private let home: URL
    private var environment: [String: String]
    private let resources: URL?
    private var bundledNode: URL?
    private(set) var isBundledRuntime = false

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser, environment: [String: String] = ProcessInfo.processInfo.environment, resources: URL? = Bundle.main.resourceURL) {
        self.home = home
        self.resources = resources
        var env = environment
        let runtimeRoot = home.appendingPathComponent(".local/share/agentklar")
        let privateBins = ((try? FileManager.default.contentsOfDirectory(atPath: runtimeRoot.path)) ?? [])
            .filter { $0.range(of: #"^node-v24\.[0-9]+\.[0-9]+-darwin-(arm64|x64)$"#, options: .regularExpression) != nil }
            .sorted().reversed().map { runtimeRoot.appendingPathComponent($0 + "/bin").path }
        env["PATH"] = (privateBins + [home.appendingPathComponent(".local/bin").path, "/opt/homebrew/bin", "/usr/local/bin", environment["PATH"] ?? "", "/usr/bin", "/bin"]).joined(separator: ":")
        env.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        self.environment = env
    }
    func performMutation<T>(_ operation: () async throws -> T) async throws -> T {
        guard !mutationRunning else { throw LocalError.message("Another local setup or update is running. Wait for it to finish.") }
        mutationRunning = true
        defer { mutationRunning = false }
        return try await operation()
    }
    var hasBundledRuntime: Bool {
        guard let resources else { return false }
        return FileManager.default.fileExists(atPath: resources.appendingPathComponent("runtime-manifest.json").path)
    }
    var hasExistingLauncher: Bool { hasBundledRuntime }
    func installService() async throws {
        try await discover()
        _ = try await runCLI(["service", "install"])
    }
    func discover() async throws {
        guard let resources else { throw LocalError.message("Open the complete AgentKlar app to start its bundled runtime.") }
        guard let expected = Bundle.main.object(forInfoDictionaryKey: "AgentKlarRuntimeManifestSHA256") as? String else { throw LocalError.message("The app's runtime identity is missing. Use a complete AgentKlar app.") }
        let cache = home.appendingPathComponent("Library/Application Support/AgentKlar/runtimes", isDirectory: true)
        let prepared = try await Task.detached {
            try BundledRuntime.prepare(resources: resources, cache: cache, expectedHash: expected)
        }.value
        bundledNode = prepared.appendingPathComponent("bin/node")
        launcher = prepared.appendingPathComponent("agentklar/bin/agentklar.mjs")
        isBundledRuntime = true
        environment["PATH"] = prepared.appendingPathComponent("bin").path + ":" + (environment["PATH"] ?? "/usr/bin:/bin")
        let version = try await Self.command(bundledNode!, args: ["--version"], environment: environment, cwd: home, timeout: 5)
        guard version.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("v24.") else { throw LocalError.message("The bundled runtime requires Node 24. Reinstall a complete AgentKlar app.") }
    }
    func runCLI(_ args: [String], timeout: TimeInterval = 30) async throws -> String {
        let allowed = [["--version"], ["service", "status"], ["service", "install"], ["service", "start"], ["service", "open", "--print"], ["service", "use-app-runtime"], ["update", "--check"], ["update"]]
        guard allowed.contains(args), let launcher, let bundledNode else { throw LocalError.message("Connect the bundled AgentKlar runtime first.") }
        if args == ["update"] { throw LocalError.message("This runtime ships with the Mac app. Update the app to update its runtime.") }
        return try await Self.command(bundledNode, args: [launcher.path] + args, environment: environment, cwd: home, timeout: timeout)
    }
    func privateLink() async throws -> URL {
        try await discover()
        let status = try await runCLI(["service", "status"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if status == "AgentKlar background startup is not installed." {
            _ = try await runCLI(["service", "install"])
            _ = try await runCLI(["service", "start"])
        } else if status == "Installed; stopped." { _ = try await runCLI(["service", "start"]) }
        else if !LocalBoundary.runningService(status) { throw LocalError.message("The managed service is paused or its health is unclear. Its existing work was kept. Resolve recovery before reconnecting.") }
        return try LocalBoundary.setupURL(await runCLI(["service", "open", "--print"]))
    }
    // Drain nonblocking pipes even if a descendant retains them. Never wait on pipe EOF.
    nonisolated static func command(_ executable: URL, args: [String], environment: [String: String], cwd: URL, timeout: TimeInterval) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                let process = Process(), out = Pipe(), err = Pipe()
                process.executableURL = executable; process.arguments = args; process.environment = environment
                process.currentDirectoryURL = cwd; process.standardInput = FileHandle.nullDevice
                process.standardOutput = out; process.standardError = err
                do { try process.run() } catch {
                    continuation.resume(throwing: LocalError.message("The bundled AgentKlar runtime could not run. Reinstall a complete app and reconnect.")); return
                }
                let pid = process.processIdentifier
                let ownedGroup = getpgid(pid) == pid
                func stop(_ signal: Int32) {
                    if ownedGroup { _ = kill(-pid, signal) }
                    else if process.isRunning { _ = kill(pid, signal) }
                }
                let outputFD = out.fileHandleForReading.fileDescriptor, errorFD = err.fileHandleForReading.fileDescriptor
                _ = fcntl(outputFD, F_SETFL, fcntl(outputFD, F_GETFL) | O_NONBLOCK)
                _ = fcntl(errorFD, F_SETFL, fcntl(errorFD, F_GETFL) | O_NONBLOCK)
                var output = Data(), error = Data(), exceeded = false, timedOut = false
                var outputEOF = false, errorEOF = false
                let deadline = ProcessInfo.processInfo.systemUptime + timeout
                var exitedAt: TimeInterval?, stoppedAt: TimeInterval?
                func drain(_ fd: Int32, into data: inout Data, eof: inout Bool, remaining: Int) {
                    var buffer = [UInt8](repeating: 0, count: 8192)
                    var capacity = remaining
                    while true {
                        let count = read(fd, &buffer, buffer.count)
                        if count == 0 { eof = true; return }
                        if count < 0 { return }
                        if count > capacity { exceeded = true; return }
                        data.append(contentsOf: buffer.prefix(count)); capacity -= count
                    }
                }
                while true {
                    drain(outputFD, into: &output, eof: &outputEOF, remaining: 65536 - output.count - error.count)
                    drain(errorFD, into: &error, eof: &errorEOF, remaining: 65536 - output.count - error.count)
                    let now = ProcessInfo.processInfo.systemUptime
                    if now >= deadline { timedOut = true }
                    if !process.isRunning && exitedAt == nil { exitedAt = now }
                    let retainedPipes = exitedAt.map { now - $0 >= 0.1 && !(outputEOF && errorEOF) } ?? false
                    if (timedOut || exceeded || retainedPipes) && stoppedAt == nil { stop(SIGTERM); stoppedAt = now }
                    if let stoppedAt, now - stoppedAt >= 0.25 { stop(SIGKILL); break }
                    if stoppedAt == nil && exitedAt != nil && outputEOF && errorEOF { break }
                    Thread.sleep(forTimeInterval: 0.01)
                }
                try? out.fileHandleForReading.close(); try? err.fileHandleForReading.close()
                if !process.isRunning && process.terminationStatus == 0 && !exceeded && !timedOut {
                    continuation.resume(returning: String(decoding: output, as: UTF8.self))
                } else {
                    continuation.resume(throwing: LocalError.message(LocalBoundary.safeError(String(decoding: error, as: UTF8.self))))
                }
            }
        }
    }
}

/// Runtime files are immutable copies. launchd never depends on the app's current location.
enum BundledRuntime {
    struct Manifest: Decodable {
        let version: String
        let nodeVersion: String
        let dataCompatibility: Int
        let files: [String: String]
    }
    static func prepare(resources: URL, cache: URL, expectedHash: String) throws -> URL {
        let manifestURL = resources.appendingPathComponent("runtime-manifest.json")
        let manifestData = try boundedFile(manifestURL, maximum: 8 * 1024 * 1024)
        let identity = digest(manifestData)
        guard identity == expectedHash else { throw LocalError.message("The app runtime manifest checksum differs. Existing service files were kept.") }
        let manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)
        guard manifest.version.range(of: "^0\\.1\\.0-beta\\.[0-9]+$", options: .regularExpression) != nil,
              manifest.nodeVersion == "24.21.0", manifest.dataCompatibility == 1,
              !manifest.files.isEmpty, manifest.files.count <= 50_000,
              manifest.files["bin/node"] != nil, manifest.files["agentklar/bin/agentklar.mjs"] != nil,
              manifest.files["agentklar/dist/server/server.js"] != nil else {
            throw LocalError.message("The app's bundled runtime manifest is unsupported. Use a complete AgentKlar app.")
        }
        let source = resources.appendingPathComponent("runtime", isDirectory: true)
        try verify(source, manifest: manifest)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try privateDirectory(cache)
        let target = cache.appendingPathComponent(identity, isDirectory: true)
        if FileManager.default.fileExists(atPath: target.path) {
            try privateDirectory(target); try verify(target, manifest: manifest); return target
        }
        let staging = cache.appendingPathComponent(".staging-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        try FileManager.default.copyItem(at: source, to: staging)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: staging.path)
        try verify(staging, manifest: manifest)
        do { try FileManager.default.moveItem(at: staging, to: target) }
        catch {
            // Another app window may have published this exact immutable runtime first.
            guard FileManager.default.fileExists(atPath: target.path) else { throw error }
            try privateDirectory(target); try verify(target, manifest: manifest)
        }
        return target
    }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func privateDirectory(_ url: URL) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let permissions = attributes[.posixPermissions] as? NSNumber, permissions.intValue & 0o077 == 0 else {
            throw LocalError.message("The private app runtime folder has changed. Existing service files were kept.")
        }
    }
    private static func boundedFile(_ url: URL, maximum: Int) throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue >= 0, size.intValue <= maximum else {
            throw LocalError.message("A bundled runtime file is missing, linked or oversized.")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximum + 1) ?? Data()
        guard data.count == size.intValue, data.count <= maximum else { throw LocalError.message("A bundled runtime file changed while reading.") }
        return data
    }
    private static func verify(_ directory: URL, manifest: Manifest) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw LocalError.message("Bundled runtime directory is missing or linked.") }
        guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil) else { throw LocalError.message("Bundled runtime files are unavailable.") }
        var seen: Set<String> = []
        var total = 0
        for case let url as URL in enumerator {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            if attributes[.type] as? FileAttributeType == .typeDirectory { continue }
            let path = String(url.standardizedFileURL.path.dropFirst(directory.standardizedFileURL.path.count + 1))
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  path.split(separator: "/").allSatisfy({ $0 != "." && $0 != ".." }),
                  let expected = manifest.files[path], expected.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
                throw LocalError.message("Bundled runtime contains an unowned or linked file.")
            }
            let data = try boundedFile(url, maximum: 256 * 1024 * 1024)
            total += data.count
            guard total <= 1024 * 1024 * 1024, digest(data) == expected else { throw LocalError.message("Bundled runtime checksum does not match. Existing service files were kept.") }
            seen.insert(path)
        }
        guard seen == Set(manifest.files.keys), FileManager.default.isExecutableFile(atPath: directory.appendingPathComponent("bin/node").path) else {
            throw LocalError.message("The app runtime is incomplete. Use a complete AgentKlar app.")
        }
    }
}
