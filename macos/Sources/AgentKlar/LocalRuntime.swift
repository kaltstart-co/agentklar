import Foundation
import Combine
import CryptoKit

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
        if text.contains("Node 24") { return "Your standalone AgentKlar launcher needs Node 24. Repair it in your terminal, then reconnect." }
        if text.range(of: "active|busy|pending", options: [.regularExpression, .caseInsensitive]) != nil { return "Finish active work or pending changes before retrying." }
        if text.range(of: "paused|recovery|maintenance", options: [.regularExpression, .caseInsensitive]) != nil { return "AgentKlar is paused for recovery. Check its terminal guidance before retrying." }
        return "AgentKlar could not finish this step. Run agentklar service status in your terminal, then reconnect."
    }
}

@MainActor final class LocalRuntime: ObservableObject {
    @Published private(set) var mutationRunning = false
    private(set) var launcher: URL?
    private let home: URL
    private let environment: [String: String]

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.home = home
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
    var hasExistingLauncher: Bool {
        ([home.appendingPathComponent(".local/bin/agentklar").path, "/opt/homebrew/bin/agentklar", "/usr/local/bin/agentklar"] + (environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/agentklar" }).contains { (try? FileManager.default.attributesOfItem(atPath: $0)) != nil }
    }
    func installService() async throws {
        guard !hasExistingLauncher else { throw LocalError.message("An existing launcher needs repair. Keep it and follow agentklar service status in your terminal.") }
        guard let script = Bundle.main.url(forResource: "install", withExtension: "sh"),
              let checksum = Bundle.main.url(forResource: "install", withExtension: "sha256") else {
            throw LocalError.message("The checked installer is missing from this app. Use a complete AgentKlar app download.")
        }
        let data = try Data(contentsOf: script)
        let expected = try String(contentsOf: checksum, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard expected.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == expected else {
            throw LocalError.message("The bundled installer checksum does not match. Download a complete AgentKlar app again.")
        }
        var env = environment; env["AGENTKLAR_INSTALL_NO_OPEN"] = "1"
        _ = try await Self.command(URL(fileURLWithPath: "/bin/bash"), args: [script.path], environment: env, cwd: home, timeout: 480)
    }
    func discover() async throws {
        let paths = [home.appendingPathComponent(".local/bin/agentklar").path, "/opt/homebrew/bin/agentklar", "/usr/local/bin/agentklar"]
            + (environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/agentklar" }
        var visited = Set<String>()
        for path in paths where visited.insert(path).inserted && FileManager.default.isExecutableFile(atPath: path) {
            let candidate = URL(fileURLWithPath: path)
            if let output = try? await Self.command(candidate, args: ["--version"], environment: environment, cwd: home, timeout: 5),
               output.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^0\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$"#, options: .regularExpression) != nil {
                launcher = candidate; return
            }
        }
        throw LocalError.message("AgentKlar is not installed or its launcher needs repair. Use the checked local installer to continue.")
    }
    func runCLI(_ args: [String], timeout: TimeInterval = 30) async throws -> String {
        let allowed = [["--version"], ["service", "status"], ["service", "install"], ["service", "start"], ["service", "open", "--print"], ["update", "--check"], ["update"]]
        guard allowed.contains(args), let launcher else { throw LocalError.message("Connect the existing AgentKlar launcher first.") }
        return try await Self.command(launcher, args: args, environment: environment, cwd: home, timeout: timeout)
    }
    func privateLink() async throws -> URL {
        try await discover()
        let status = try await runCLI(["service", "status"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if status == "AgentKlar background startup is not installed." {
            _ = try await runCLI(["service", "install"])
            _ = try await runCLI(["service", "start"])
        } else if status == "Installed; stopped." { _ = try await runCLI(["service", "start"]) }
        else if !LocalBoundary.runningService(status) { throw LocalError.message("The managed service is paused or its health is unclear. Check agentklar service status in your terminal.") }
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
                    continuation.resume(throwing: LocalError.message("The AgentKlar launcher could not run. Repair it in your terminal.")); return
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
