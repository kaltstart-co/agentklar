import SwiftUI

/// Edits only the two managed native defaults through reviewed server receipts.
struct NativeDefaultsView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var harness = "claude"
    @State private var settings: JSON = .null
    @State private var preview: JSON = .null
    @State private var model = ""
    @State private var effort = ""
    @State private var working = false
    @State private var failure = ""
    @State private var notice = ""
    private var scope: String { client.projectID + ":" + harness + ":" + String(client.connected) }
    private var base: String { "/projects/\(client.projectID)/native-settings" }
    private var efforts: [String] { harness == "claude" ? ["low", "medium", "high", "xhigh"] : ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Native defaults").font(.headline)
            Picker("Harness", selection: $harness) {
                Text("Claude Code").tag("claude")
                Text("Codex").tag("codex")
            }
            Text(harness == "claude" ? "Local project scope. Applies to this project's Claude Code sessions." : "User scope. Applies to all your Codex projects.").foregroundStyle(.secondary)
            Text("Model access and supported effort depend on your native CLI and account.").font(.caption).foregroundStyle(.secondary)
            if client.projectID.isEmpty { Text("Choose a project to manage native defaults.") }
            if let path = settings["path"].string { Text(path).font(.caption).textSelection(.enabled) }
            Button("Refresh defaults", systemImage: "arrow.clockwise") { Task { await load() } }
            Group {
                TextField("Default model", text: $model, prompt: Text("Use native fallback"))
                HStack {
                    Button("Preview model") { Task { await change("preview", field: "model") } }
                    Button("Clear model draft") { model = "" }
                }
                Picker("Default effort", selection: $effort) {
                    Text("Use native fallback").tag("")
                    ForEach(efforts, id: \.self) { Text($0).tag($0) }
                    if !effort.isEmpty && !efforts.contains(effort) { Text("Current: \(effort) · support unknown").tag(effort) }
                }
                Button("Preview effort") { Task { await change("preview", field: "effort") } }
            }.disabled(settings == .null)
            Text("Clearing a draft removes that default field and uses the native fallback.").font(.caption).foregroundStyle(.secondary)
            if preview["id"].string != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(preview["key"].string ?? "Default") · \(preview["scope"].string ?? "Unknown scope")").font(.headline)
                    Text("Before: \(preview["before"].string ?? "Native fallback")")
                    Text("After: \(preview["after"].string ?? "Native fallback")")
                    Text(preview["message"].string ?? "").foregroundStyle(.secondary)
                    DisclosureGroup("Review path and saved preview") { Text(preview.prettyText).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                    Button("Apply reviewed default") { Task { await change("apply") } }
                }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
            ForEach(settings["changes"].array ?? [], id: \.self) { receipt in
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(receipt["field"].string ?? "Default") · \(receipt["state"].string ?? "Unknown state")")
                    if let message = receipt["message"].string { Text(message).font(.caption).foregroundStyle(.secondary) }
                    if receipt["canUndo"].bool == true, let id = receipt["id"].string {
                        Button("Undo unchanged \(receipt["field"].string ?? "default")") { Task { await change("undo", changeID: id) } }
                    } else if receipt["state"].string == "interrupted" {
                        Label("Inspect the native config. This receipt cannot safely undo changed settings.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    }
                    DisclosureGroup("Managed change receipt") { Text(receipt.prettyText).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                }
            }
            if working { ProgressView("Reading or changing native defaults…").controlSize(.small) }
            if !notice.isEmpty { Text(notice).foregroundStyle(.secondary) }
            if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
        }
        .disabled(working || client.busy || !client.connected || client.projectID.isEmpty)
        .onChange(of: model) { _, _ in preview = .null }
        .onChange(of: effort) { _, _ in preview = .null }
        .task(id: scope) {
            settings = .null; preview = .null; model = ""; effort = ""; failure = ""; notice = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if !Task.isCancelled { await load() }
        }
    }

    private func adopt(_ value: JSON) { settings = value; model = value["model"].string ?? ""; effort = value["effort"].string ?? "" }
    private func load() async {
        guard !working, client.connected, !client.projectID.isEmpty else { return }
        let captured = scope, path = base + "/" + harness
        working = true; failure = ""; preview = .null
        defer { working = false }
        do { let next = try await client.request(path); if captured == scope { adopt(next) } }
        catch { if captured == scope { settings = .null; failure = error.localizedDescription } }
    }
    private func change(_ operation: String, field: String? = nil, changeID: String? = nil) async {
        guard !working, !client.busy, client.connected, !client.projectID.isEmpty else { return }
        let captured = scope, path = base, selected = harness
        var body: [String: Any] = [:]
        if operation == "preview", let field {
            let value = field == "model" ? model.trimmingCharacters(in: .whitespacesAndNewlines) : effort
            body = ["harness": selected, "field": field, "value": value.isEmpty ? NSNull() : value as Any]
        } else if operation == "apply", let id = preview["id"].string { body = ["previewId": id] }
        else if operation == "undo", let changeID { body = ["changeId": changeID] }
        else { return }
        working = true; failure = ""; notice = ""
        defer { working = false }
        do {
            let next = try await client.request(path + "/" + operation, body: body)
            if captured == scope {
                if operation == "preview" { preview = next }
                else { preview = .null; notice = "Default changed. Start a new native session to load it." }
            }
        } catch { if captured == scope { failure = error.localizedDescription; preview = .null } }
        // Interrupted commands may have a recoverable receipt even after an error.
        if operation != "preview", captured == scope {
            do { let next = try await client.request(path + "/" + selected); if captured == scope { adopt(next) } }
            catch { if captured == scope { settings = .null; failure = error.localizedDescription } }
        }
    }
}
