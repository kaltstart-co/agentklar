import SwiftUI
import AppKit

struct NativeSettingsView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var harness = "codex"
    @State private var status: JSON = .null
    @State private var preview: JSON = .null
    @State private var installations: [JSON] = []
    @State private var choices: [String: String] = [:]
    @State private var working = false
    @State private var message = ""
    @State private var failure = ""
    private let supported = ["codex", "claude", "muse", "opencode", "antigravity"]
    private var scope: String { client.projectID + ":" + harness }
    private var configured: Bool { status["status"].string == "configured" && status["change"]["state"].string != "interrupted" }

    var body: some View {
        Form {
            Section("Project") {
                Picker("Project", selection: Binding(get: { client.projectID }, set: { id in Task { await client.selectProject(id) } })) {
                    Text("Choose a project").tag("")
                    ForEach(client.projects, id: \.self) { row in Text(row["name"].string ?? "Project").tag(row["id"].string ?? "") }
                }.disabled(working)
                if let path = client.project["path"].string { Text(path).foregroundStyle(.secondary).textSelection(.enabled) }
                Button("Add project folder…", systemImage: "folder.badge.plus") { chooseProject() }.disabled(working || !client.connected)
                if client.onboarding["projectId"].string == client.projectID, let main = client.onboarding["mainHarness"].string {
                    Text("Saved main harness: \(main)").foregroundStyle(.secondary)
                }
            }
            Section("Native connection") {
                Picker("Harness", selection: $harness) {
                    ForEach(supported, id: \.self) { id in HStack { NativeHarnessIcon(harness: id); Text(name(id)) }.tag(id) }
                }.disabled(working)
                Text(harness == "claude" ? "Local project scope. Only this project's Claude Code sessions." : "User scope. Available to this harness's projects.").foregroundStyle(.secondary)
                Text("Your native account, trust and permissions stay in your harness.").foregroundStyle(.secondary)
                if let text = status["message"].string { Text(text).textSelection(.enabled) }
                if status["change"]["state"].string == "interrupted" { Label("Interrupted setup needs attention", systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                HStack {
                    Button("Refresh status") { Task { await loadStatus() } }
                    Button("Preview connection") { Task { await setup("preview") } }.disabled(status["status"].string != "missing")
                    if status["canUndo"].bool == true { Button("Undo managed connection") { Task { await setup("undo") } } }
                }.disabled(working || !client.connected || client.projectID.isEmpty)
                if configured {
                    Button("Use as main harness") { Task { await saveMain() } }.disabled(working || !client.connected)
                }
                if preview["id"].string != nil { previewSection }
                Text("A configured entry does not confirm sign-in, available tools or remaining quota.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Native installations on this computer") {
                Button("Find native installations", systemImage: "arrow.clockwise") { Task { await loadInstallations() } }.disabled(working || !client.connected)
                ForEach(installations, id: \.self) { entry in installationRow(entry) }
                Text("Version discovery does not prove protocol or tool support. Finish work before restarting the service.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Updates") { NativeUpdateSettings(client: client) }
            if !message.isEmpty { Section { Text(message).foregroundStyle(.secondary) } }
            if !failure.isEmpty { Section { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) } }
        }
        .formStyle(.grouped)
        .disabled(client.busy)
        .navigationTitle("Settings")
        .task(id: scope + ":" + String(client.connected)) {
            status = .null; preview = .null; message = ""; failure = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if client.connected && !Task.isCancelled { await loadStatus() }
        }
    }

    private var previewSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Reviewed connection · \(preview["scope"].string ?? "Unknown") scope").font(.headline)
            Text(preview["configPath"].string ?? "Config path unavailable").textSelection(.enabled)
            if let cwd = preview["cwd"].string { Text("Project: \(cwd)").textSelection(.enabled) }
            if let command = preview["command"].string { Text(command).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
            Text(pretty(preview["entry"])).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            Text("No account token is added to native settings.").font(.caption).foregroundStyle(.secondary)
            Button("Apply reviewed connection") { Task { await setup("apply") } }.disabled(working || !client.connected)
        }
    }

    private func installationRow(_ entry: JSON) -> some View {
        let id = entry["harness"].string ?? "unknown"
        let found = entry["installations"].array ?? []
        let selected = choices[id] ?? entry["current"]["path"].string ?? entry["saved"].string ?? entry["selected"].string ?? ""
        return VStack(alignment: .leading, spacing: 6) {
            HStack { NativeHarnessIcon(harness: id); Text(name(id)).font(.headline) }
            Text("Service CLI: \(entry["selected"].string ?? "Not available")").font(.caption).textSelection(.enabled)
            if entry["changed"].bool == true || entry["restartRequired"].bool == true {
                Label("Installation changed. Finish work, then restart the service.", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.orange)
                if let version = entry["baseline"]["version"].string { Text("Previously: \(version)").font(.caption) }
                if let version = entry["current"]["version"].string { Text("Found: \(version)").font(.caption) }
            }
            Picker("Installation", selection: Binding(get: { selected }, set: { choices[id] = $0 })) {
                Text("Choose an installation").tag("")
                ForEach(found, id: \.self) { item in Text("\(item["version"].string ?? "Version unknown") · \(item["path"].string ?? "")").tag(item["path"].string ?? "") }
            }.disabled(working || found.isEmpty)
            Button("Save for next restart") { Task { await saveInstallation(id, path: selected, found: found) } }.disabled(working || !client.connected || !found.contains { $0["path"].string == selected })
        }
    }

    private func name(_ id: String) -> String { client.harnesses.first { $0["id"].string == id }?["name"].string ?? id }
    private func pretty(_ value: JSON) -> String {
        guard let data = try? JSONEncoder().encode(value), let object = try? JSONSerialization.jsonObject(with: data), let formatted = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return "Entry unavailable" }
        return String(decoding: formatted, as: UTF8.self)
    }
    private func perform(_ action: () async throws -> Void) async {
        guard !working, client.connected else { return }
        let captured = scope
        working = true; failure = ""
        defer { working = false }
        do { try await action() } catch { if captured == scope { failure = error.localizedDescription; preview = .null } }
    }
    private func loadStatus() async {
        guard !client.projectID.isEmpty else { return }
        let captured = scope, path = "/projects/\(client.projectID)/setup/\(harness)"
        await perform { let value = try await client.request(path); if captured == scope { status = value; preview = .null } }
    }
    private func setup(_ operation: String) async {
        let captured = scope, path = "/projects/\(client.projectID)/setup/\(harness)"
        var body: [String: Any] = [:]
        if operation == "apply" { guard let id = preview["id"].string else { return }; body["previewId"] = id }
        if operation == "undo" { guard status["canUndo"].bool == true, let id = status["change"]["id"].string else { return }; body["changeId"] = id }
        await perform {
            let value = try await client.request(path + "/" + operation, body: body)
            guard captured == scope else { return }
            if operation == "preview" { preview = value }
            else {
                preview = .null
                let next = try await client.request(path)
                if captured == scope { status = next; message = "Entry changed. Restart your native session to load it." }
            }
        }
    }
    private func saveMain() async {
        guard configured, let revision = client.onboarding["revision"].number else { return }
        let projectID = client.projectID, selected = harness
        await perform {
            _ = try await client.request("/onboarding", body: ["projectId": projectID, "mainHarness": selected, "expectedRevision": Int(revision)], method: "PUT")
            await client.refresh()
            message = "Main harness saved. Open it normally in this project."
        }
    }
    private func chooseProject() {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        Task { await perform { let row = try await client.request("/projects", body: ["name": folder.lastPathComponent, "path": folder.path]); await client.refresh(); if let id = row["id"].string { await client.selectProject(id) } } }
    }
    private func loadInstallations() async { await perform { installations = try await client.request("/native-installations").array ?? []; choices = [:] } }
    private func saveInstallation(_ id: String, path: String, found: [JSON]) async {
        guard let item = found.first(where: { $0["path"].string == path }), let fingerprint = item["fingerprint"].string else { return }
        await perform {
            let result = try await client.request("/native-installations", body: ["harness": id, "path": path, "fingerprint": fingerprint])
            installations = try await client.request("/native-installations").array ?? []
            message = result["restartRequired"].bool == true ? "Choice saved. Finish work before restarting AgentKlar." : "This installation is already selected."
        }
    }
}
