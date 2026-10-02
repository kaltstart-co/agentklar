import AppKit
import Combine
import Security
import Sparkle
import SwiftUI

@MainActor
final class NativeUpdates: NSObject, ObservableObject, SPUUpdaterDelegate {
    @Published private(set) var enabled = false
    @Published private(set) var canCheck = false
    @Published private(set) var message = "App updates need a signed public release. Service updates remain available."
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
        message = "Signed app updates are checked by Sparkle. Your background service keeps running."
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

    var body: some View {
        LabeledContent("Mac app", value: Bundle.main.object(forInfoDictionaryKey: "AgentKlarReleaseVersion") as? String ?? "Development")
        Text(updates.message).foregroundStyle(.secondary)
        if updates.enabled { Button("Check for app updates") { updates.checkForUpdates() }.disabled(!updates.canCheck || !client.maintenanceReady) }
        LabeledContent("Local service", value: status["current"].string ?? "Checking…")
        if let latest = status["latest"].string { LabeledContent("Latest service", value: latest) }
        if let error = status["error"].string { Text(error).foregroundStyle(.secondary) }
        if !failure.isEmpty { Text(failure).foregroundStyle(.secondary) }
        HStack {
            Button("Check service updates") { Task { await check(refresh: true) } }.disabled(checking || client.busy)
            if status["installation"]["supported"].bool == true {
                Button("Update local service") { confirm = true }.disabled(status["available"].bool != true || checking || !client.maintenanceReady)
            }
        }
        .confirmationDialog("Update the local AgentKlar service? Save open drafts first.", isPresented: $confirm) {
            Button("Update service") { Task { await client.updateService(); await check(refresh: false) } }
            Button("Cancel", role: .cancel) {}
        }
        .task { await check(refresh: false) }
    }

    private func check(refresh: Bool) async {
        guard !checking else { return }
        checking = true; defer { checking = false }
        do { status = try await client.request(refresh ? "/update/check" : "/update", body: refresh ? [:] : nil); failure = "" }
        catch { failure = error.localizedDescription }
    }
}
