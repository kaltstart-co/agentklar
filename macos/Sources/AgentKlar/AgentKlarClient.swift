import Foundation
import Combine
import AppKit

private final class LocalSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let origin: URL
    init(origin: URL) { self.origin = origin }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url.map { LocalBoundary.sameOrigin($0, origin) } == true ? request : nil)
    }
}

@MainActor final class AgentKlarClient: ObservableObject {
    @Published var snapshot: JSON = .object([:])
    @Published var onboarding: JSON = .object([:])
    @Published var projectID = ""
    @Published var requestedRunID: String?
    @Published var connected = false
    @Published var busy = false
    @Published private(set) var pendingWrites = 0
    @Published var error = ""
    let runtime: LocalRuntime
    private var session: URLSession?
    private var origin: URL?
    private var refreshing = false
    var projects: [JSON] { snapshot["projects"].array ?? [] }
    var project: JSON { projects.first { $0["id"].string == projectID } ?? .object([:]) }
    var runs: [JSON] { (snapshot["runs"].array ?? []).filter { projectID.isEmpty || $0["projectId"].string == projectID } }
    var harnesses: [JSON] { snapshot["harnesses"].array ?? [] }
    var maintenanceReady: Bool { !busy && !runtime.mutationRunning && pendingWrites == 0 }

    init(runtime: LocalRuntime? = nil) { self.runtime = runtime ?? LocalRuntime() }
    func connect() async {
        guard maintenanceReady else { error = "Finish the current local change before reconnecting."; return }
        do { try await runtime.performMutation { try await reconnectInsideMutation() } }
        catch { self.error = errorText(error) }
    }
    func reconnectInsideMutation() async throws {
        busy = true; defer { busy = false }
        let link = try await runtime.privateLink()
        let base = URL(string: "http://127.0.0.1:\(link.port!)")!
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 150
        config.httpShouldSetCookies = true
        let newSession = URLSession(configuration: config, delegate: LocalSessionDelegate(origin: base), delegateQueue: nil)
        let (_, response) = try await bounded(newSession, URLRequest(url: link))
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.url.map({ LocalBoundary.sameOrigin($0, base) }) == true else {
            newSession.invalidateAndCancel(); throw LocalError.message("The private local session could not connect. Reconnect to obtain a fresh link.")
        }
        session?.invalidateAndCancel(); session = newSession; origin = base
        connected = true
        do { try await loadSnapshot(); error = "" }
        catch { connected = false; throw error }
    }
    func request(_ path: String, body: [String: Any]? = nil, method: String? = nil) async throws -> JSON {
        guard let session, let origin else { throw LocalError.message("Connect the local AgentKlar service first.") }
        let method = method ?? (body == nil ? "GET" : "POST")
        guard ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method) else { throw LocalError.message("Unsupported local API method.") }
        var request = URLRequest(url: try LocalBoundary.apiURL(path, origin: origin))
        request.httpMethod = method
        request.timeoutInterval = Self.requestTimeout(path)
        if method != "GET" { request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin") }
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let writing = method != "GET"
        if writing {
            guard !busy, !runtime.mutationRunning else { throw LocalError.message("Finish setup or the service update before changing local work.") }
            pendingWrites += 1
        }
        defer { if writing { pendingWrites -= 1 } }
        let (data, response) = try await bounded(session, request)
        guard let response = response as? HTTPURLResponse, let url = response.url, LocalBoundary.sameOrigin(url, origin) else {
            throw LocalError.message("Only the authenticated local service may answer this request.")
        }
        let jsonResponse = response.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("application/json") == true
        if path == "/onboarding" && (response.statusCode == 404 || (response.statusCode == 200 && !jsonResponse)) {
            throw LocalError.message("Your local service needs an update to support this native app. Choose Update local service.")
        }
        guard jsonResponse else { throw LocalError.message("The local service returned an unsupported response. Reconnect or update the local service.") }
        let value = try JSONDecoder().decode(JSON.self, from: data)
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 { connected = false }
            throw LocalError.message(value["error"].string.map { String($0.prefix(400)) } ?? "The local service refused this request.")
        }
        return value
    }
    private func bounded(_ session: URLSession, _ request: URLRequest) async throws -> (Data, URLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        if response.expectedContentLength > 2 * 1024 * 1024 { throw LocalError.message("Local response exceeded its size limit.") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 2 * 1024 * 1024 else { throw LocalError.message("Local response exceeded its size limit.") }
            data.append(byte)
        }
        return (data, response)
    }
    private func loadSnapshot() async throws {
        let next = try await request("/snapshot")
        if snapshot != next { snapshot = next }
        adoptOnboarding(try await request("/onboarding"))
        if !projects.contains(where: { $0["id"].string == projectID }) {
            projectID = onboarding["projectId"].string ?? projects.first?["id"].string ?? ""
            if !projects.contains(where: { $0["id"].string == projectID }) { projectID = projects.first?["id"].string ?? "" }
        }
    }
    func adoptOnboarding(_ next: JSON) {
        if next != onboarding, (next["revision"].number ?? -1) >= (onboarding["revision"].number ?? -1) { onboarding = next }
    }
    func refresh() async {
        guard connected, !busy, !refreshing else { return }
        refreshing = true; defer { refreshing = false }
        do { try await loadSnapshot(); error = "" } catch { self.error = errorText(error) }
    }
    func selectProject(_ id: String) async {
        guard projects.contains(where: { $0["id"].string == id }) else { return }
        do {
            adoptOnboarding(try await request("/onboarding", body: ["projectId": id, "mainHarness": onboarding["mainHarness"].any,
                "expectedRevision": onboarding["revision"].number ?? 0], method: "PUT"))
            projectID = id; error = ""
        } catch { self.error = errorText(error) }
    }
    func registerProject(name: String, path: String) async {
        do {
            let result = try await request("/projects", body: ["name": name, "path": path])
            try await loadSnapshot()
            if let id = result["id"].string { await selectProject(id) }
        } catch { self.error = errorText(error) }
    }
    func installService() async {
        guard maintenanceReady else { error = "Finish the current local change before setup."; return }
        do { try await runtime.performMutation {
            let alert = NSAlert(); alert.messageText = "Set up AgentKlar locally?"
            alert.informativeText = "The checked installer will install the AgentKlar service for your user. Your coding apps and accounts stay in place."
            alert.addButton(withTitle: "Set up"); alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            busy = true; defer { busy = false }
            try await runtime.installService()
            try await reconnectInsideMutation()
        } } catch { self.error = errorText(error) }
    }
    func updateService() async {
        guard maintenanceReady else { error = "Finish the current local change before updating."; return }
        do { try await runtime.performMutation {
            busy = true; defer { busy = false }
            guard LocalBoundary.idleService(try await runtime.runCLI(["service", "status"])) else {
                throw LocalError.message("Finish active work and confirm the managed service is healthy before updating.")
            }
            _ = try await runtime.runCLI(["update"], timeout: 480)
            try await reconnectInsideMutation()
        } } catch { self.error = errorText(error) }
    }
    private func errorText(_ error: Error) -> String {
        (error as? LocalError)?.errorDescription ?? "The local service could not finish this request. Reconnect and try again."
    }
    static func requestTimeout(_ path: String) -> TimeInterval {
        let parts = path.split(separator: "?", maxSplits: 1)[0].split(separator: "/")
        if parts.contains("skills") { return 135 }
        if parts.contains("plugins") || parts.contains("recommend") || path == "/tasks/start" { return 120 }
        if parts.contains("native-settings") { return 60 }
        if parts.contains("changes") || parts.contains("remote-approvals") || parts.contains("peers") || parts.first == "runs" { return 60 }
        return parts.contains("setup") ? 35 : 20
    }
}
