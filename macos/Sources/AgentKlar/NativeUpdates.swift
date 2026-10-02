import AppKit
import Combine
import Security
import Sparkle
import SwiftUI

@MainActor
final class NativeUpdates: NSObject, ObservableObject, SPUUpdaterDelegate {
    @Published private(set) var enabled = false
    @Published private(set) var canCheck = false
    @Published private(set) var message = "Automatic app updates are unavailable in this development preview."
    private var controller: SPUStandardUpdaterController?
    private var observation: AnyCancellable?
    private weak var client: AgentKlarClient?
    private var pendingInstall: (() -> Void)?
    private var ownsBusy = false
    private var installing = false

    init(client: AgentKlarClient) {
        self.client = client
        super.init()
        guard Self.isSignedRelease() else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        observation = controller.updater.publisher(for: \.canCheckForUpdates).sink { [weak self] value in
            guard let self else { return }
            self.canCheck = value || self.pendingInstall != nil
        }
        enabled = true
        message = "Signed app updates are enabled."
        controller.startUpdater()
    }

    func checkForUpdates() {
        guard enabled, client?.maintenanceReady == true else { return }
        if pendingInstall != nil { finishInstallation(); return }
        controller?.checkForUpdates(nil)
    }

    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        guard client?.maintenanceReady == true else { throw NSError(domain: "AgentKlar", code: 1, userInfo: [NSLocalizedDescriptionKey: "Finish local changes, setup or the service update before checking app updates."]) }
    }

    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        pendingInstall = installHandler
        canCheck = true
        finishInstallation()
        return true
    }

    private func finishInstallation() {
        guard let client, pendingInstall != nil, !installing else { return }
        guard client.maintenanceReady else { message = "Finish local changes, then choose Check for App Updates again to install."; return }
        installing = true
        Task {
            defer { installing = false }
            do {
                try await client.runtime.performMutation {
                    guard client.pendingWrites == 0 else { throw LocalError.message("A local change started. Finish it before restarting AgentKlar.") }
                    ownsBusy = true
                    client.busy = true
                    let status = try await client.runtime.runCLI(["service", "status"])
                    guard LocalBoundary.idleService(status) else { throw LocalError.message("Finish active work, then choose Check for App Updates again to install.") }
                    let confirmation = NSAlert()
                    confirmation.messageText = "Restart AgentKlar to finish the app update?"
                    confirmation.informativeText = "Save open drafts first. Your local background service remains running."
                    confirmation.addButton(withTitle: "Restart app")
                    confirmation.addButton(withTitle: "Later")
                    guard confirmation.runModal() == .alertFirstButtonReturn else { releaseBusy(); return }
                    guard LocalBoundary.idleService(try await client.runtime.runCLI(["service", "status"])) else {
                        throw LocalError.message("New work started. Finish it, then choose Check for App Updates again.")
                    }
                    let handler = pendingInstall
                    pendingInstall = nil
                    handler?()
                    // Keep app actions disabled while Sparkle completes the restart.
                }
            } catch { releaseBusy(); message = error.localizedDescription }
        }
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        releaseBusy()
        message = "The app update stopped. Your current app and local service remain available."
    }

    private func releaseBusy() {
        guard ownsBusy else { return }
        ownsBusy = false
        client?.busy = false
    }

    static func isSignedRelease() -> Bool {
        guard Bundle.main.object(forInfoDictionaryKey: "AgentKlarSignedRelease") as? Bool == true,
              Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String == "https://agentklar-seven.vercel.app/appcast.xml",
              let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              Data(base64Encoded: key)?.count == 32 else { return false }
        var code: SecStaticCode?
        var requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &code) == errSecSuccess,
              SecRequirementCreateWithString("anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" as CFString, [], &requirement) == errSecSuccess,
              let code, let requirement else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures), requirement) == errSecSuccess
    }
}

struct NativeUpdateSettings: View {
    @ObservedObject var client: AgentKlarClient
    @EnvironmentObject var updates: NativeUpdates
    @State private var status: JSON = .null
    @State private var checking = false
    @State private var confirm = false
    @State private var failure = ""

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "AgentKlarReleaseVersion") as? String ?? "Development"
    }
    private var bundled: Bool { client.runtime.isBundledRuntime }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "app").font(.system(size: 24)).foregroundStyle(.secondary).frame(width: 32)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Mac app").font(NativeStyle.heading)
                    Text(appVersion).font(NativeStyle.caption).foregroundStyle(.secondary)
                    Text(updates.message).font(NativeStyle.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                if updates.enabled {
                    Button("Check for updates") { updates.checkForUpdates() }
                        .buttonStyle(.bordered).disabled(!updates.canCheck || !client.maintenanceReady)
                }
            }
            Divider()
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "gearshape.2").font(.system(size: 24)).foregroundStyle(.secondary).frame(width: 32)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Background service").font(NativeStyle.heading)
                    Text(serviceSummary).font(NativeStyle.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                if checking { ProgressView().controlSize(.small).accessibilityLabel("Checking service releases") }
                else {
                    Button { Task { await check(refresh: true) } } label: {
                        Image(systemName: "arrow.clockwise").frame(width: 28, height: 28).contentShape(Rectangle())
                    }.buttonStyle(.plain).foregroundStyle(.secondary).disabled(client.busy)
                        .accessibilityLabel("Check service releases").help("Check service releases")
                }
                if bundled {
                    Button("Use bundled runtime") { confirm = true }
                        .buttonStyle(.borderedProminent).disabled(checking || !client.maintenanceReady)
                } else if status["installation"]["supported"].bool == true {
                    Button("Update service") { confirm = true }
                        .buttonStyle(.borderedProminent)
                        .disabled(status["available"].bool != true || checking || !client.maintenanceReady)
                }
            }
            if let error = status["error"].string {
                Label(error, systemImage: "exclamationmark.triangle").font(NativeStyle.caption)
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            if !failure.isEmpty {
                Label(failure, systemImage: "exclamationmark.triangle").font(NativeStyle.caption)
                    .foregroundStyle(.red).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            NativeDetailButton("Update and runtime details") {
                VStack(alignment: .leading, spacing: 12) {
                    LabeledContent("Mac app", value: appVersion)
                    Text(updates.message).fixedSize(horizontal: false, vertical: true)
                    Text(updates.enabled
                         ? "Signed app releases use Sparkle. Updating the app keeps the background service running. Use the runtime action to upgrade that component."
                         : "This development preview has no automatic app updates. The background runtime ships with the app.")
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Divider()
                    LabeledContent("Running service", value: status["current"].string ?? "Not checked")
                    if bundled {
                        LabeledContent("Bundled runtime", value: appVersion)
                        Text("Use this app's bundled runtime when work is idle. Existing projects and harness accounts stay in place. A newer service release may require a newer app.")
                            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    if let latest = status["latest"].string { LabeledContent("Last checked service release", value: latest) }
                    Text(status.prettyText).font(NativeStyle.source).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }.buttonStyle(.plain).foregroundStyle(.tint)
        }.frame(maxWidth: 800, alignment: .leading)
        .confirmationDialog(bundled ? "Use this app’s bundled background runtime? Save open drafts first." : "Update the local AgentKlar service? Save open drafts first.", isPresented: $confirm, titleVisibility: .visible) {
            Button(bundled ? "Use bundled runtime" : "Update service") {
                Task { await client.updateService(); await check(refresh: false) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if bundled { Text("Uses the runtime bundled with app version \(appVersion). Finish active work first.") }
        }
        .task { await check(refresh: false) }
    }

    private var serviceSummary: String {
        let current = status["current"].string ?? "Not checked"
        if status["available"].bool == true, let latest = status["latest"].string {
            return "\(current) · \(latest) available"
        }
        return current + (bundled ? " · app includes runtime \(appVersion)" : " · local installation")
    }

    private func check(refresh: Bool) async {
        guard !checking else { return }
        checking = true; defer { checking = false }
        do { status = try await client.request(refresh ? "/update/check" : "/update", body: refresh ? [:] : nil); failure = "" }
        catch { failure = error.localizedDescription }
    }
}
