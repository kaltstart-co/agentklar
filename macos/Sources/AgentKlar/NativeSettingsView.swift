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
    @State private var connectionGeneration = 0
    @State private var message = ""
    @State private var failure = ""
    @State private var showingInstallations = false
    @State private var showingConnectionDetails = false
    @State private var connectionStatuses: [String: JSON] = [:]
    private let supported = ["codex", "claude", "muse", "opencode", "antigravity"]
    private var scope: String { client.projectID + ":" + harness }
    private var configured: Bool { status["status"].string == "configured" && status["change"]["state"].string != "interrupted" }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            NativePageHeader(title: "Settings", subtitle: "Your harnesses and computers.") { EmptyView() }
            NativePageTabs(selection: $selectedTab, items: ["Connections", "Defaults", "Devices", "Updates"])
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
        }.frame(maxWidth: NativeStyle.contentWidth, alignment: .leading)
            .padding(NativeStyle.pagePadding).frame(maxWidth: .infinity, alignment: .top)
            .font(NativeStyle.body).disabled(client.busy)
    }
    private var connections: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 10) {
                Image(systemName: "folder").foregroundStyle(.secondary)
                Text(client.project["name"].string ?? "Choose a project").fontWeight(.medium)
                if client.onboarding["projectId"].string == client.projectID, let main = client.onboarding["mainHarness"].string {
                    Text("Main: \(name(main))").font(NativeStyle.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 24) {
                    harnessList.frame(width: 220)
                    Divider()
                    connectionDetail.frame(minWidth: 300, maxWidth: .infinity, alignment: .leading)
                }
                VStack(alignment: .leading, spacing: 20) {
                    harnessList
                    Divider()
                    connectionDetail
                }
            }
            if !message.isEmpty { Label(message, systemImage: "checkmark.circle").font(NativeStyle.caption).fixedSize(horizontal: false, vertical: true).foregroundStyle(.secondary) }
            if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").fixedSize(horizontal: false, vertical: true).foregroundStyle(.red).textSelection(.enabled) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .disabled(client.busy)
        .sheet(isPresented: $showingInstallations) { installationManager }
        .sheet(isPresented: $showingConnectionDetails) {
            NativeDetailPage(title: "Connection details") { connectionDetails }
        }
        .task(id: scope + ":" + String(client.connected)) {
            connectionGeneration += 1
            status = .null; preview = .null; message = ""; failure = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if client.connected && !Task.isCancelled { await loadStatus() }
        }
    }

    private var harnessList: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Harnesses").font(NativeStyle.heading)
                Spacer()
                Text("\(client.harnesses.filter { $0["available"].bool == true }.count) installed")
                    .font(NativeStyle.caption).foregroundStyle(.secondary)
            }.padding(.bottom, 4)
            ForEach(supported, id: \.self) { id in
                let installed = client.harnesses.first { $0["id"].string == id }?["available"].bool == true
                let rowStatus = id == harness ? status : connectionStatuses[client.projectID + ":" + id] ?? .null
                Button { harness = id } label: {
                    HStack(spacing: 10) {
                        NativeHarnessIcon(harness: id, size: 28)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(name(id)).fontWeight(id == harness ? .semibold : .regular)
                            Text(rowStatus["status"].string == "configured" ? "Connected" : rowStatus["status"].string == "conflict" ? "Needs review" : installed ? "Installed" : "Not found")
                                .font(NativeStyle.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        if id == harness { Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.tint) }
                    }.padding(10).contentShape(Rectangle())
                        .background(id == harness ? Color.accentColor.opacity(0.09) : Color.clear, in: RoundedRectangle(cornerRadius: NativeStyle.cornerRadius))
                }.buttonStyle(.plain).disabled(working)
                    .accessibilityAddTraits(id == harness ? .isSelected : [])
            }
            Button("Manage installations…") { showingInstallations = true }
                .buttonStyle(.plain).foregroundStyle(.tint).font(NativeStyle.caption)
                .padding(.top, 8).disabled(working || !client.connected)
        }
    }

    private var connectionDetail: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                NativeHarnessIcon(harness: harness, size: 36)
                VStack(alignment: .leading, spacing: 4) {
                    Text(name(harness)).font(NativeStyle.title)
                    Text(harness == "claude" ? "Connection for this project" : "Connection for your projects")
                        .font(NativeStyle.caption).foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Label(connectionState, systemImage: configured ? "checkmark.circle.fill" : status["status"].string == "conflict" ? "exclamationmark.triangle.fill" : "circle.dotted")
                    .fontWeight(.medium).foregroundStyle(status["status"].string == "conflict" ? Color.orange : Color.primary)
                Text(connectionSummary).font(NativeStyle.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if status["change"]["state"].string == "interrupted" {
                    Label("Interrupted setup needs attention", systemImage: "exclamationmark.triangle").font(NativeStyle.caption).foregroundStyle(.orange)
                }
            }.padding(.vertical, 4)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { connectionActions }.fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 12) { connectionActions }
            }.controlSize(.regular).disabled(working || !client.connected || client.projectID.isEmpty)
            if working { Text("Working on connection…").font(NativeStyle.caption).foregroundStyle(.secondary) }
            Button("Connection details…") { showingConnectionDetails = true }
                .buttonStyle(.plain).foregroundStyle(.tint).font(NativeStyle.caption)
            if preview["id"].string != nil { previewSection }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var connectionSummary: String {
        switch status["status"].string {
        case "configured": return "Start or restart your harness session to load AgentKlar."
        case "missing": return "Connect AgentKlar to share project context with this harness. Review the change before applying it."
        case "conflict": return status["canUpdate"].bool == true ? "An older connection points to this service. Review the old and new bridge paths, then update it." : "An AgentKlar entry already exists. Review it before changing the connection."
        case "unavailable": return status["message"].string ?? "Connection status could not be checked."
        default: return client.connected ? "Checking this harness's native settings." : "Start the local service to check this connection."
        }
    }

    private var connectionDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(harness == "claude" ? "Local project scope. Only this project's Claude Code sessions." : "User scope. Available to this harness's projects.")
            if let path = client.project["path"].string { Text("Project: \(path)") }
            if let text = status["message"].string { Text(text) }
            Text("Accounts, trust and permissions stay in your harness. A configured entry does not prove sign-in, tools or quota.")
        }.font(NativeStyle.body).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
    }

    @ViewBuilder private var connectionActions: some View {
        if preview["id"].string == nil {
            if status["status"].string == "missing" {
                Button("Connect \(name(harness))…") { Task { await setup("preview") } }
                    .buttonStyle(.borderedProminent)
            } else if status["status"].string == "conflict" {
                if status["canUpdate"].bool == true {
                    Button("Review update…") { Task { await setup("preview") } }.buttonStyle(.borderedProminent)
                } else {
                    Button("Review conflict…") { showingConnectionDetails = true }.buttonStyle(.borderedProminent)
                }
            } else if configured && (client.onboarding["projectId"].string != client.projectID || client.onboarding["mainHarness"].string != harness) {
                Button("Use as main harness") { Task { await saveMain() } }.buttonStyle(.bordered)
            }
        }
        Button("Refresh") { Task { await loadStatus() } }.buttonStyle(.bordered)
        if status["canUndo"].bool == true {
            Button(status["change"]["replacesExisting"].bool == true ? "Undo connection update" : "Remove connection", role: .destructive) { Task { await setup("undo") } }
                .buttonStyle(.bordered)
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
        GroupBox(preview["operation"].string == "replace" ? "Review connection update" : "Review connection") {
            VStack(alignment: .leading, spacing: 16) {
                Label("\(name(harness)) · \(preview["scope"].string ?? "Unknown") scope", systemImage: "doc.text.magnifyingglass")
                Text(preview["configPath"].string ?? "Config path unavailable").fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if let cwd = preview["cwd"].string { Text("Project: \(cwd)").fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                if let command = preview["command"].string { Text(command).font(.system(size: 12, design: .monospaced)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                if preview["operation"].string == "replace" {
                    Text("Current connection").font(NativeStyle.heading)
                    Text(pretty(preview["previousEntry"])).font(.system(size: 12, design: .monospaced)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    Text("Updated connection").font(NativeStyle.heading)
                }
                Text(pretty(preview["entry"])).font(.system(size: 12, design: .monospaced)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                Text("No account token is added.").font(NativeStyle.caption).foregroundStyle(.secondary)
                HStack(spacing: 12) {
                    Button(preview["operation"].string == "replace" ? "Update connection" : "Apply connection") { Task { await setup("apply") } }
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
        let captured = scope, generation = connectionGeneration
        working = true; failure = ""
        defer { working = false }
        do { try await action() } catch { if captured == scope && generation == connectionGeneration { failure = error.localizedDescription; preview = .null } }
    }
    private func loadStatus() async {
        guard !client.projectID.isEmpty else { return }
        let captured = scope, generation = connectionGeneration, path = "/projects/\(client.projectID)/setup/\(harness)"
        await perform { let value = try await client.request(path); if captured == scope && generation == connectionGeneration { status = value; connectionStatuses[captured] = value; preview = .null } }
    }
    private func setup(_ operation: String) async {
        let captured = scope, generation = connectionGeneration, path = "/projects/\(client.projectID)/setup/\(harness)"
        var body: [String: Any] = [:]
        if operation == "apply" { guard let id = preview["id"].string else { return }; body["previewId"] = id }
        if operation == "undo" { guard status["canUndo"].bool == true, let id = status["change"]["id"].string else { return }; body["changeId"] = id }
        await perform {
            let value = try await client.request(path + "/" + operation, body: body)
            guard captured == scope && generation == connectionGeneration else { return }
            if operation == "preview" { preview = value }
            else {
                preview = .null
                let next = try await client.request(path)
                if captured == scope && generation == connectionGeneration { status = next; connectionStatuses[captured] = next; message = "Entry changed. Restart your native session to load it." }
            }
        }
    }
    private func saveMain() async {
        guard configured, let revision = client.onboarding["revision"].number else { return }
        let projectID = client.projectID, selected = harness, generation = connectionGeneration
        await perform {
            _ = try await client.request("/onboarding", body: ["projectId": projectID, "mainHarness": selected, "expectedRevision": Int(revision)], method: "PUT")
            await client.refresh()
            guard client.projectID == projectID && harness == selected && generation == connectionGeneration else { return }
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
