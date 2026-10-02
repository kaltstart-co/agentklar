import SwiftUI

/// Edits only the two managed native defaults through reviewed server receipts.
struct NativeDefaultsView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var harness = "claude"
    @State private var settings: JSON = .null
    @State private var preview: JSON = .null
    @State private var model = ""
    @State private var effort = ""
    @State private var draftOwner = ""
    @State private var modelBaseline = ""
    @State private var effortBaseline = ""
    @State private var working = false
    @State private var failure = ""
    @State private var notice = ""
    private var owner: String { client.projectID + ":" + harness }
    private var scope: String { owner + ":" + String(client.connected) }
    private var base: String { "/projects/\(client.projectID)/native-settings" }
    private var efforts: [String] { harness == "claude" ? ["low", "medium", "high", "xhigh"] : ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }

    private var scopeLabel: String { harness == "claude" ? "This project's Claude Code sessions" : "All your Codex projects" }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    harnessPicker
                    Text(client.projectID.isEmpty ? "Choose a project to manage defaults." : scopeLabel)
                        .font(NativeStyle.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                refreshButton
            }
            if settings == .null && !client.projectID.isEmpty {
                Label(working ? "Reading defaults…" : "Defaults not loaded", systemImage: "circle.dotted")
                    .font(NativeStyle.caption).foregroundStyle(.secondary)
            }
            Divider()
            HStack(spacing: 12) {
                Label("Model", systemImage: "cpu").frame(width: 90, alignment: .leading)
                TextField("Default model", text: $model, prompt: Text("Native fallback"))
                    .textFieldStyle(.roundedBorder).frame(minWidth: 120, maxWidth: .infinity)
                Button { model = "" } label: { Image(systemName: "xmark.circle") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).disabled(model.isEmpty)
                    .accessibilityLabel("Clear model draft").help("Clear the draft to use the native fallback")
                Button("Review") { Task { await change("preview", field: "model") } }
                    .buttonStyle(.bordered).accessibilityLabel("Review model change")
            }.disabled(settings == .null)
            HStack(spacing: 12) {
                Label("Effort", systemImage: "gauge.with.dots.needle.50percent").frame(width: 90, alignment: .leading)
                Picker("Effort", selection: $effort) {
                    Text("Native fallback").tag("")
                    ForEach(efforts, id: \.self) { Text($0).tag($0) }
                    if !effort.isEmpty && !efforts.contains(effort) { Text("Current: \(effort) · support unknown").tag(effort) }
                }.pickerStyle(.menu).labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                Button("Review") { Task { await change("preview", field: "effort") } }
                    .buttonStyle(.bordered).accessibilityLabel("Review effort change")
            }.disabled(settings == .null)
            HStack {
                Text("Changes apply to new native sessions.").font(NativeStyle.caption).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                NativeDetailButton("Default details") {
                    Text(scopeLabel).font(NativeStyle.heading)
                    if let path = settings["path"].string { LabeledContent("Config file", value: path).textSelection(.enabled) }
                    Text("Model access and supported effort depend on your native CLI and account. An empty model draft or Native fallback removes the managed field and uses the native fallback.")
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if let message = settings["message"].string { Text(message).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                }.buttonStyle(.plain).foregroundStyle(.tint)
            }
            if preview["id"].string != nil { reviewChange }
            if !(settings["changes"].array ?? []).isEmpty {
                Divider()
                Text("Managed changes").font(NativeStyle.heading)
            }
            ForEach(settings["changes"].array ?? [], id: \.self) { receipt in
                receiptRow(receipt)
                Divider()
            }
            if working { ProgressView().controlSize(.small).accessibilityLabel("Reading or changing defaults") }
            if !notice.isEmpty { Label(notice, systemImage: "checkmark.circle").font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").font(NativeStyle.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
        }.font(NativeStyle.body).frame(maxWidth: .infinity, alignment: .leading)
        .disabled(working || client.busy || !client.connected || client.projectID.isEmpty)
        .onChange(of: model) { _, _ in preview = .null }
        .onChange(of: effort) { _, _ in preview = .null }
        .task(id: scope) {
            let captured = scope
            if draftOwner != owner {
                draftOwner = owner
                model = ""; effort = ""; modelBaseline = ""; effortBaseline = ""
            }
            settings = .null; preview = .null; failure = ""; notice = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if !Task.isCancelled, captured == scope, client.connected { await load() }
        }
    }

    private var reviewChange: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            HStack(spacing: 10) {
                Image(systemName: "doc.text.magnifyingglass").foregroundStyle(.secondary)
                Text("Review \(preview["field"].string ?? "default") change").font(NativeStyle.heading)
                Spacer()
                Text(preview["scope"].string ?? "Unknown scope").font(NativeStyle.caption).foregroundStyle(.secondary)
            }
            LabeledContent("Before", value: preview["before"].string ?? "Native fallback")
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            LabeledContent("After", value: preview["after"].string ?? "Native fallback")
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            Text("Native model access and effort support still apply.").font(NativeStyle.caption).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button("Apply reviewed default") { Task { await change("apply") } }.buttonStyle(.borderedProminent)
                Button("Cancel") { preview = .null }.buttonStyle(.plain).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                NativeDetailButton("Exact change") {
                    Text(preview["message"].string ?? "").fixedSize(horizontal: false, vertical: true)
                    Text(preview.prettyText).font(NativeStyle.source).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }.buttonStyle(.plain).foregroundStyle(.tint)
            }
        }
    }

    private func receiptRow(_ receipt: JSON) -> some View {
        let field = receipt["field"].string ?? "Default"
        let state = receipt["state"].string ?? "Unknown state"
        let interrupted = state == "interrupted"
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Image(systemName: interrupted ? "exclamationmark.triangle" : "clock.arrow.circlepath")
                    .foregroundStyle(interrupted ? Color.orange : Color.secondary).frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(field.capitalized + " default").fontWeight(.medium)
                    Text(state.capitalized).font(NativeStyle.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                if receipt["canUndo"].bool == true, let id = receipt["id"].string {
                    Button("Undo") { Task { await change("undo", changeID: id) } }
                        .buttonStyle(.bordered).help("Undo only if the native setting is unchanged")
                        .accessibilityLabel("Undo unchanged \(field) default")
                }
                NativeDetailButton("Receipt") {
                    Text(receipt.prettyText).font(NativeStyle.source).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }.buttonStyle(.plain).foregroundStyle(.tint)
            }
            if interrupted {
                Text(receipt["message"].string ?? "The change was interrupted. Inspect native settings before recovery.")
                    .font(NativeStyle.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                if receipt["canUndo"].bool != true {
                    Text("This receipt cannot safely undo the changed settings.")
                        .font(NativeStyle.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var harnessPicker: some View {
        Picker("Harness", selection: $harness) {
            HStack { NativeHarnessIcon(harness: "claude", size: 18); Text("Claude Code") }.tag("claude")
            HStack { NativeHarnessIcon(harness: "codex", size: 18); Text("Codex") }.tag("codex")
        }.pickerStyle(.menu)
    }
    private var refreshButton: some View {
        Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise").frame(width: 28, height: 28).contentShape(Rectangle()) }
            .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Refresh defaults").help("Refresh defaults")
    }

    private func adopt(_ value: JSON, preservingDrafts: Bool = false) {
        let dirtyModel = model != modelBaseline, dirtyEffort = effort != effortBaseline
        settings = value
        modelBaseline = value["model"].string ?? ""
        effortBaseline = value["effort"].string ?? ""
        if !preservingDrafts || !dirtyModel { model = modelBaseline }
        if !preservingDrafts || !dirtyEffort { effort = effortBaseline }
    }
    private func load() async {
        guard !working, client.connected, !client.projectID.isEmpty else { return }
        let captured = scope, path = base + "/" + harness
        working = true; failure = ""; preview = .null
        defer { working = false }
        do { let next = try await client.request(path); if captured == scope, client.connected { adopt(next, preservingDrafts: true) } }
        catch { if captured == scope, client.connected { settings = .null; failure = error.localizedDescription } }
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
        var confirmedChange = false
        defer { working = false }
        do {
            let next = try await client.request(path + "/" + operation, body: body)
            if captured == scope, client.connected {
                if operation == "preview" { preview = next }
                else { confirmedChange = true; preview = .null; notice = "Default changed. Start a new native session to load it." }
            }
        } catch { if captured == scope, client.connected { failure = error.localizedDescription; preview = .null } }
        // Interrupted commands may have a recoverable receipt even after an error.
        if operation != "preview", captured == scope, client.connected {
            do { let next = try await client.request(path + "/" + selected); if captured == scope, client.connected { adopt(next, preservingDrafts: !confirmedChange) } }
            catch { if captured == scope, client.connected { settings = .null; failure = error.localizedDescription } }
        }
    }
}
