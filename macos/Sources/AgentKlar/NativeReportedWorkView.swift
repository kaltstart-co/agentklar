import SwiftUI

struct NativeReportedWorkDetail: View {
    let activity: JSON
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(activity["title"].string ?? "Task").font(NativeStyle.title).textSelection(.enabled)
                HStack {
                    Label(activity["source"]["clientName"].string ?? "Harness", systemImage: "text.bubble")
                    Spacer()
                    Text(activity["state"].string?.capitalized ?? "Unknown")
                }.font(NativeStyle.caption).foregroundStyle(.secondary)
                Text("Reported by the harness. AgentKlar does not monitor or control this native session.")
                    .font(NativeStyle.caption).foregroundStyle(.secondary)
                if let revision = activity["revision"].number {
                    Text("Report revision \(revision.formatted(.number.precision(.fractionLength(0))))")
                        .font(NativeStyle.caption).foregroundStyle(.secondary)
                }
                NativeDetailButton("Report details") {
                    LabeledContent("Task ID", value: activity["activityId"].string ?? "Unknown")
                    LabeledContent("Report ID", value: activity["reportId"].string ?? "Unknown")
                    if let created = activity["createdAt"].string { Text("First reported: " + created) }
                    if let updated = activity["updatedAt"].string { Text("Last reported: " + updated) }
                }.textSelection(.enabled)
                Divider()
                Text("Progress").font(NativeStyle.heading)
                Text(activity["summary"].string ?? "").font(NativeStyle.document).lineSpacing(5).textSelection(.enabled)
                if let result = activity["result"].string, !result.isEmpty {
                    Divider()
                    Text("Reported result").font(NativeStyle.heading)
                    Text(result).font(NativeStyle.document).lineSpacing(5).textSelection(.enabled)
                }
                if let date = reportedDate {
                    Text("Last reported \(date.formatted(date: .abbreviated, time: .shortened))")
                        .font(NativeStyle.caption).foregroundStyle(.secondary)
                }
            }.frame(maxWidth: 760, alignment: .leading).padding(NativeStyle.pagePadding).frame(maxWidth: .infinity)
        }
    }
    private var reportedDate: Date? {
        guard let text = activity["updatedAt"].string else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text)
    }
}
