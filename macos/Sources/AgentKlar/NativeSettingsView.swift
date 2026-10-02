import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct NativeSettingsView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var selectedTab = "Connections"
    @State private var harness = "codex"
    @State private var status: JSON = .null
    @State private var preview: JSON = .null
    @State private var installations: [JSON] = []
    @State private var choices: [String: String] = [:]
    @State private var working = false
    @State private var message = ""
    @State private var failure = ""
    @State private var showingInstallations = false
    private let supported = ["codex", "claude", "muse", "opencode", "antigravity"]
    private var scope: String { client.projectID + ":" + harness }
    private var configured: Bool { status["status"].string == "configured" && status["change"]["state"].string != "interrupted" }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            NativePageHeader(title: "Settings", subtitle: "Connections, defaults and this Mac.") { EmptyView() }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 24) {
                    ForEach(["Connections", "Defaults", "Devices", "Updates"], id: \.self) { tab in
                        Button { selectedTab = tab } label: {
                            VStack(spacing: 8) {
                                Text(tab).font(.system(size: 14, weight: selectedTab == tab ? .semibold : .regular))
                                    .foregroundStyle(selectedTab == tab ? Color.primary : Color.secondary)
                                Rectangle().fill(selectedTab == tab ? Color.accentColor : .clear).frame(height: 2)
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain).fixedSize(horizontal: true, vertical: false)
                            .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
                    }
                    Spacer(minLength: 0)
                }
            }.fixedSize(horizontal: false, vertical: true)
            ZStack(alignment: .topLeading) {
                ScrollView {
                    NativeDefaultsView(client: client).frame(maxWidth: .infinity, alignment: .leading)
                }
                .opacity(selectedTab == "Defaults" ? 1 : 0)
                .disabled(selectedTab != "Defaults")
                .allowsHitTesting(selectedTab == "Defaults")
                .accessibilityElement(children: .contain)
                .accessibilityHidden(selectedTab != "Defaults")
                if selectedTab == "Devices" {
                    NativeDevicesView(client: client)
                } else if selectedTab != "Defaults" {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 24) {
                            if selectedTab == "Connections" { connections }
                            else { NativeUpdateSettings(client: client) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }.padding(NativeStyle.pagePadding).font(NativeStyle.body).disabled(client.busy)
    }
    private var connections: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Project", value: client.project["name"].string ?? "Choose a project")
                if let path = client.project["path"].string {
                    Text(path).font(NativeStyle.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                if client.onboarding["projectId"].string == client.projectID, let main = client.onboarding["mainHarness"].string {
                    Label("Main: \(name(main))", systemImage: "checkmark.circle").font(NativeStyle.caption).foregroundStyle(.secondary)
                }
            }
            Divider()
            Text("Use AgentKlar in a harness").font(NativeStyle.heading)
            Picker("Harness", selection: $harness) {
                ForEach(supported, id: \.self) { id in HStack { NativeHarnessIcon(harness: id); Text(name(id)) }.tag(id) }
            }.pickerStyle(.menu).disabled(working)
            Label(connectionState, systemImage: configured ? "checkmark.circle" : status["status"].string == "conflict" ? "exclamationmark.triangle" : "circle.dotted")
                .foregroundStyle(configured ? .secondary : .primary)
            if status["change"]["state"].string == "interrupted" { Label("Interrupted setup needs attention", systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            if status["status"].string == "conflict" || status["status"].string == "unavailable", let text = status["message"].string {
                Text(text).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { connectionActions }.fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 12) { connectionActions }
            }.controlSize(.regular).disabled(working || !client.connected || client.projectID.isEmpty)
            NativeDetailButton("Connection details") {
                VStack(alignment: .leading, spacing: 8) {
                    Text(harness == "claude" ? "Local project scope. Only this project's Claude Code sessions." : "User scope. Available to this harness's projects.")
                    Text("Accounts, trust and permissions stay in your harness. A configured entry does not prove sign-in, tools or quota.")
                    if let text = status["message"].string { Text(text).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                }.font(NativeStyle.caption).foregroundStyle(.secondary)
            }.buttonStyle(.plain).foregroundStyle(.tint)
            if preview["id"].string != nil { previewSection }
            Divider()
            HStack {
                Text("Installed harnesses").font(NativeStyle.heading)
                Spacer()
            }
            Text("\(client.harnesses.filter { $0["available"].bool == true }.count) found on this Mac. AgentKlar uses your existing installations.")
                .foregroundStyle(.secondary)
            Button("Manage installations…") { showingInstallations = true }
                .buttonStyle(.plain).foregroundStyle(.tint).disabled(working || !client.connected)
            if !message.isEmpty { Label(message, systemImage: "checkmark.circle").fixedSize(horizontal: false, vertical: true).foregroundStyle(.secondary) }
            if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").fixedSize(horizontal: false, vertical: true).foregroundStyle(.red).textSelection(.enabled) }
        }
        .frame(maxWidth: 800, alignment: .leading)
        .disabled(client.busy)
        .sheet(isPresented: $showingInstallations) { installationManager }
        .task(id: scope + ":" + String(client.connected)) {
            status = .null; preview = .null; message = ""; failure = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if client.connected && !Task.isCancelled { await loadStatus() }
        }
    }

    @ViewBuilder private var connectionActions: some View {
        if preview["id"].string == nil {
            if status["status"].string == "missing" {
                Button("Connect \(name(harness))…") { Task { await setup("preview") } }
                    .buttonStyle(.borderedProminent)
            } else if configured && (client.onboarding["projectId"].string != client.projectID || client.onboarding["mainHarness"].string != harness) {
                Button("Use as main harness") { Task { await saveMain() } }.buttonStyle(.bordered)
            }
        }
        Button { Task { await loadStatus() } } label: {
            Image(systemName: "arrow.clockwise").frame(width: 28, height: 28).contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(.secondary)
            .accessibilityLabel("Refresh connection status").help("Refresh connection status")
        if status["canUndo"].bool == true {
            Menu {
                Button("Remove managed connection", role: .destructive) { Task { await setup("undo") } }
            } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).fixedSize().help("Connection actions")
        }
    }

    private var connectionState: String {
        switch status["status"].string {
        case "configured": return configured ? "Connection installed" : "Setup needs attention"
        case "missing": return "Setup needed"
        case "conflict": return "Conflicting entry"
        case "unavailable": return "Status unavailable"
        default: return "Status not checked"
        }
    }
    private var previewSection: some View {
        GroupBox("Review connection") {
            VStack(alignment: .leading, spacing: 16) {
                Label("\(name(harness)) · \(preview["scope"].string ?? "Unknown") scope", systemImage: "doc.text.magnifyingglass")
                Text(preview["configPath"].string ?? "Config path unavailable").fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if let cwd = preview["cwd"].string { Text("Project: \(cwd)").fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                if let command = preview["command"].string { Text(command).font(.system(size: 12, design: .monospaced)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                Text(pretty(preview["entry"])).font(.system(size: 12, design: .monospaced)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                Text("No account token is added.").font(NativeStyle.caption).foregroundStyle(.secondary)
                HStack(spacing: 12) {
                    Button("Apply connection") { Task { await setup("apply") } }
                        .buttonStyle(.borderedProminent).disabled(working || !client.connected)
                    Button("Cancel") { preview = .null }.buttonStyle(.plain).disabled(working)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
        }
    }

    private var installationManager: some View {
        NativeDetailPage(title: "Harness installations") {
            HStack {
                Text("Choose which installed version AgentKlar uses.").foregroundStyle(.secondary)
                Spacer()
                Button { Task { await loadInstallations() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).accessibilityLabel("Refresh installations").help("Refresh installations")
            }
            Text("Changes take effect after a restart. Finish active work first.")
                .font(NativeStyle.caption).foregroundStyle(.secondary)
            if installations.isEmpty { Text(working ? "Finding installations…" : "No installations found.").foregroundStyle(.secondary) }
            ForEach(installations, id: \.self) { entry in installationRow(entry) }
            if !message.isEmpty { Label(message, systemImage: "checkmark.circle").foregroundStyle(.secondary) }
            if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
        }.disabled(client.busy).task { await loadInstallations() }
    }

    private func installationRow(_ entry: JSON) -> some View {
        let id = entry["harness"].string ?? "unknown"
        let found = entry["installations"].array ?? []
        let selected = choices[id] ?? entry["current"]["path"].string ?? entry["saved"].string ?? entry["selected"].string ?? ""
        return VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) { NativeHarnessIcon(harness: id); Text(name(id)).fontWeight(.semibold); Spacer(); Text(entry["current"]["version"].string ?? "Version unknown").font(NativeStyle.caption).foregroundStyle(.secondary) }
                if entry["changed"].bool == true || entry["restartRequired"].bool == true {
                    Label("Finish work, then restart the service.", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.orange)
                }
                Picker("Installation", selection: Binding(get: { selected }, set: { choices[id] = $0 })) {
                    Text("Choose an installation").tag("")
                    ForEach(found, id: \.self) { item in Text("\(item["version"].string ?? "Version unknown") · \(item["path"].string ?? "")").tag(item["path"].string ?? "") }
                }.disabled(working || found.isEmpty)
                Button("Save for next restart") { Task { await saveInstallation(id, path: selected, found: found) } }.disabled(working || !client.connected || !found.contains { $0["path"].string == selected })
                NativeDetailButton("Installation paths and status") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Service CLI: \(entry["selected"].string ?? "Not available")")
                        if !selected.isEmpty { Text("Choice: \(selected)") }
                        if let version = entry["baseline"]["version"].string { Text("Previously: \(version)") }
                        if let version = entry["current"]["version"].string { Text("Found: \(version)") }
                        if entry["changed"].bool == true || entry["restartRequired"].bool == true { Text("Harness installation changed. Finish work, then restart the service to refresh its connection.") }
                    }.font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }.buttonStyle(.plain).foregroundStyle(.tint)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 16)
            Divider()
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
