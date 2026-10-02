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
            Picker("Harness", selection: $harness) {
                HStack { NativeHarnessIcon(harness: "claude", size: 18); Text("Claude Code") }.tag("claude")
                HStack { NativeHarnessIcon(harness: "codex", size: 18); Text("Codex") }.tag("codex")
            }
            Label(settings == .null ? "Defaults not loaded" : "Native defaults loaded", systemImage: settings == .null ? "circle.dotted" : "checkmark.circle").foregroundStyle(.secondary)
            Text(harness == "claude" ? "This project's Claude Code sessions." : "All your Codex projects.").font(.system(size: 11)).foregroundStyle(.secondary)
            if client.projectID.isEmpty { Text("Choose a project to manage native defaults.") }
            Button("Refresh defaults", systemImage: "arrow.clockwise") { Task { await load() } }
            GroupBox("Model") {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Default model", text: $model, prompt: Text("Native fallback"))
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) { modelActions }.fixedSize(horizontal: true, vertical: false)
                        VStack(alignment: .leading, spacing: 12) { modelActions }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }.disabled(settings == .null)
            GroupBox("Effort") {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Default effort", selection: $effort) {
                        Text("Native fallback").tag("")
                        ForEach(efforts, id: \.self) { Text($0).tag($0) }
                        if !effort.isEmpty && !efforts.contains(effort) { Text("Current: \(effort) · support unknown").tag(effort) }
                    }
                    Button("Preview effort") { Task { await change("preview", field: "effort") } }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }.disabled(settings == .null)
            DisclosureGroup("Default details") {
                VStack(alignment: .leading, spacing: 8) {
                    if let path = settings["path"].string { Text(path).textSelection(.enabled) }
                    Text("Model access and supported effort depend on your native CLI and account. An empty draft removes the managed field and uses the native fallback.")
                }.font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if preview["id"].string != nil {
                GroupBox("Review default change") {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("\(preview["key"].string ?? "Default") · \(preview["scope"].string ?? "Unknown scope")", systemImage: "doc.text.magnifyingglass").fontWeight(.semibold)
                        Text("Before: \(preview["before"].string ?? "Native fallback")")
                        Text("After: \(preview["after"].string ?? "Native fallback")")
                        Text(preview["message"].string ?? "").foregroundStyle(.secondary)
                        DisclosureGroup("Exact path and saved preview") { Text(preview.prettyText).font(.system(size: 11, design: .monospaced)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                        Button("Apply reviewed default") { Task { await change("apply") } }
                    }.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true).padding(8)
                }
            }
            ForEach(settings["changes"].array ?? [], id: \.self) { receipt in
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("\(receipt["field"].string ?? "Default") · \(receipt["state"].string ?? "Unknown state")", systemImage: receipt["state"].string == "interrupted" ? "exclamationmark.triangle" : "clock.arrow.circlepath").fontWeight(.semibold)
                        if let message = receipt["message"].string { Text(message).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                        if receipt["canUndo"].bool == true, let id = receipt["id"].string {
                            Button("Undo unchanged \(receipt["field"].string ?? "default")") { Task { await change("undo", changeID: id) } }
                        } else if receipt["state"].string == "interrupted" {
                            Label("Inspect the native config. Changed settings cannot be safely undone by this receipt.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        }
                        DisclosureGroup("Managed change receipt") { Text(receipt.prettyText).font(.system(size: 11, design: .monospaced)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
            }
            if working { ProgressView("Reading or changing defaults…").controlSize(.small) }
            if !notice.isEmpty { Label(notice, systemImage: "checkmark.circle").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
        }.font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
        .disabled(working || client.busy || !client.connected || client.projectID.isEmpty)
        .onChange(of: model) { _, _ in preview = .null }
        .onChange(of: effort) { _, _ in preview = .null }
        .task(id: scope) {
            settings = .null; preview = .null; model = ""; effort = ""; failure = ""; notice = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if !Task.isCancelled { await load() }
        }
    }

    @ViewBuilder private var modelActions: some View {
        Button("Preview model") { Task { await change("preview", field: "model") } }
        Button("Clear draft") { model = "" }
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
