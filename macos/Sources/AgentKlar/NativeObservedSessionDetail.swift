import SwiftUI

struct NativeObservedSessionDetail: View {
    @ObservedObject var client: AgentKlarClient
    let session: JSON
    @State private var stopping = false
    @State private var confirmStop = false
    static func stateLabel(_ session: JSON) -> String {
        let label = session["event"].string == "StopFailure" ? "Turn needs attention" : (["working": "Responding", "idle": "Between replies", "needs_attention": "Waiting for permission", "ended": "Session ended"][session["state"].string ?? ""] ?? "Unknown")
        return "Last seen: " + label
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                NativeObservedSessionSignals(session: session)
                if session["trackingEnabled"].bool == true {
                    Button("Stop tracking Claude sessions") { confirmStop = true }
                        .buttonStyle(.plain).foregroundStyle(.secondary).disabled(stopping || !client.connected)
                }
            }.frame(maxWidth: 640, alignment: .leading).padding(NativeStyle.pagePadding).frame(maxWidth: .infinity)
        }
        .confirmationDialog("Stop tracking Claude sessions for this project?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop tracking") { Task { await stopTracking() } }
        } message: { Text("Saved observations remain. Your Claude session keeps running. Reinstall the workflow plugin with tracking enabled to resume.") }
    }
    private func stopTracking() async {
        guard !stopping, let projectID = session["projectId"].string, projectID == client.projectID else { return }
        stopping = true; defer { stopping = false }
        do { _ = try await client.request("/projects/\(projectID)/observations/disable", body: [:]); await client.refresh() }
        catch { client.reportError(error.localizedDescription) }
    }
}

// Read-only content shared by local and owner-workspace observations.
// This view has no client and cannot disable tracking or answer a permission.
struct NativeObservedSessionSignals: View {
    let session: JSON
    var remote = false
    static func trackingStatus(_ session: JSON) -> String {
        if session["trackingEnabled"].bool != true { return "Tracking off" }
        let timestamp = session["observedAt"].string.flatMap(date)
        guard session["recent"].bool == true, let timestamp,
              Date().timeIntervalSince(timestamp) <= 300 else { return "No recent signal" }
        return "Tracking enabled"
    }
    static func trackingLabel(_ session: JSON) -> String {
        switch trackingStatus(session) {
        case "Tracking off": return "Tracking stopped. This is a saved observation."
        case "No recent signal": return "No recent signal. The current session state is unknown."
        default: return "Tracking enabled. This is the latest saved signal."
        }
    }
    private static func date(_ text: String) -> Date? {
        let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let result = format.date(from: text) { return result }
        format.formatOptions = [.withInternetDateTime]
        return format.date(from: text)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 12) {
                NativeHarnessIcon(harness: session["harness"].string ?? "claude", size: 32)
                Text("Claude Code session").font(NativeStyle.title)
            }
            Label(NativeObservedSessionDetail.stateLabel(session), systemImage: "waveform.path").font(NativeStyle.body)
            if let text = session["observedAt"].string, let date = Self.date(text) {
                Text("Last signal \(date.formatted(date: .abbreviated, time: .shortened))").font(NativeStyle.caption).foregroundStyle(.secondary)
            }
            Text(Self.trackingLabel(session)).font(NativeStyle.caption).foregroundStyle(.secondary)
            if remote {
                Text("Read only. Refresh to read the latest owner signal. Manage tracking on the owner Mac. Permissions stay in Claude Code.")
                    .font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            Text("Work stays in Claude").font(NativeStyle.heading)
            Text("AgentKlar records session signals. Reply end and session end do not mean a task succeeded. Review the work in Claude Code.")
                .font(NativeStyle.body).fixedSize(horizontal: false, vertical: true)
            Text("Conversations, prompts and tool inputs are not collected. Permissions are handled by Claude Code. To share a task summary, ask Claude to report it to AgentKlar.")
                .font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}
