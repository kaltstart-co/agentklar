import SwiftUI

enum NativeStyle {
    static let body = Font.system(size: 14)
    static let document = Font.system(size: 15)
    static let source = Font.system(size: 15, design: .monospaced)
    static let heading = Font.system(size: 15, weight: .semibold)
    static let title = Font.system(size: 22, weight: .semibold)
    static let caption = Font.system(size: 12)
    static let pagePadding: CGFloat = 28
    static let contentWidth: CGFloat = 960
    static let cornerRadius: CGFloat = 8
}

/// One header and action area for every workspace page.
struct NativePageHeader<Actions: View>: View {
    let title: String
    let subtitle: String?
    let actions: Actions
    init(title: String, subtitle: String? = nil, @ViewBuilder actions: () -> Actions) {
        self.title = title; self.subtitle = subtitle; self.actions = actions()
    }
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 24) {
                heading
                Spacer(minLength: 16)
                HStack(spacing: 8) { actions }.fixedSize()
            }
            VStack(alignment: .leading, spacing: 16) {
                heading
                HStack(spacing: 8) { actions }
            }
        }.font(NativeStyle.body).controlSize(.regular).buttonStyle(.bordered)
    }
    private var heading: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(NativeStyle.title).lineLimit(1)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle).font(NativeStyle.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }.fixedSize(horizontal: false, vertical: true)
    }
}

/// Flat page tabs, shared by document, model and settings workspaces.
struct NativePageTabs: View {
    @Binding var selection: String
    let items: [String]
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 22) {
                ForEach(items, id: \.self) { item in
                    Button { selection = item } label: {
                        VStack(spacing: 10) {
                            Text(item).font(.system(size: 14, weight: selection == item ? .medium : .regular))
                                .foregroundStyle(selection == item ? .primary : .secondary)
                            Rectangle().fill(selection == item ? Color.accentColor : .clear).frame(height: 2)
                        }.padding(.top, 4).contentShape(Rectangle())
                    }.buttonStyle(.plain).fixedSize(horizontal: true, vertical: false)
                        .accessibilityAddTraits(selection == item ? .isSelected : [])
                }
            }
        }.fixedSize(horizontal: false, vertical: true)
            .overlay(alignment: .bottom) { Rectangle().fill(.quaternary).frame(height: 1) }
    }
}

struct NativeSearchField: View {
    let placeholder: String
    @Binding var text: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField(placeholder, text: $text).textFieldStyle(.plain).accessibilityLabel(placeholder)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain).accessibilityLabel("Clear " + placeholder.lowercased())
            }
        }.font(NativeStyle.body).padding(.horizontal, 10).frame(height: 34)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: NativeStyle.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: NativeStyle.cornerRadius).strokeBorder(.quaternary))
    }
}

struct NativeSectionTitle: View {
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(NativeStyle.heading)
            if let subtitle { Text(subtitle).font(NativeStyle.caption).foregroundStyle(.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct NativeEmptyState<Actions: View>: View {
    let title: String
    let systemImage: String
    let description: String
    let actions: Actions
    init(_ title: String, systemImage: String, description: String, @ViewBuilder actions: () -> Actions) {
        self.title = title; self.systemImage = systemImage; self.description = description; self.actions = actions()
    }
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: systemImage).font(.system(size: 32, weight: .light)).foregroundStyle(.secondary)
                .padding(.bottom, 4)
            Text(title).font(NativeStyle.title)
            Text(description).font(NativeStyle.body).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) { actions }.padding(.top, 4)
        }.frame(maxWidth: 400).padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .buttonStyle(.bordered).controlSize(.regular)
    }
}
