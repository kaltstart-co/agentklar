import Foundation

// A heading is a view into the original text. Untouched ranges are never reserialized.
struct NativeMemoryEntry: Identifiable {
    let id: Int
    let title: String
    let titleRange: NSRange
    let fullRange: NSRange
    let bodyRange: NSRange
}

struct NativeMemoryDocument {
    let text: String
    let entries: [NativeMemoryEntry]
    let prefixRange: NSRange

    init(_ text: String) {
        self.text = text
        let string = text as NSString
        let expression = try! NSRegularExpression(pattern: "(?m)^## ([^\\r\\n]+)(?:\\r?\\n|$)")
        let headings = expression.matches(in: text, range: NSRange(location: 0, length: string.length))
        var prefixEnd = headings.first?.range.location ?? string.length
        if !headings.isEmpty {
            while prefixEnd > 0, [10, 13].contains(Int(string.character(at: prefixEnd - 1))) { prefixEnd -= 1 }
        }
        prefixRange = NSRange(location: 0, length: prefixEnd)
        entries = headings.enumerated().map { index, heading in
            let start = NSMaxRange(heading.range)
            let fullEnd = index + 1 < headings.count ? headings[index + 1].range.location : string.length
            var end = index + 1 < headings.count ? headings[index + 1].range.location : string.length
            // Keep separators outside the editor so the next heading stays a heading.
            if index + 1 < headings.count {
                while end > start, [10, 13].contains(Int(string.character(at: end - 1))) { end -= 1 }
            }
            return NativeMemoryEntry(id: index, title: string.substring(with: heading.range(at: 1)), titleRange: heading.range(at: 1), fullRange: NSRange(location: heading.range.location, length: fullEnd - heading.range.location), bodyRange: NSRange(location: start, length: end - start))
        }
    }

    func body(_ id: Int) -> String {
        let range = id == -1 ? prefixRange : entries.first(where: { $0.id == id })?.bodyRange
        return range.map { (text as NSString).substring(with: $0) } ?? ""
    }

    func replacingBody(_ id: Int, with body: String) -> String {
        let range = id == -1 ? prefixRange : entries.first(where: { $0.id == id })?.bodyRange
        guard let range else { return text }
        let string = text as NSString
        let needsNewline = id != -1 && range.location > 0 && range.location == string.length && ![10, 13].contains(Int(string.character(at: range.location - 1))) && !body.isEmpty
        return string.replacingCharacters(in: range, with: (needsNewline ? "\n" : "") + body)
    }

    func renaming(_ id: Int, to title: String) -> String {
        guard let entry = entries.first(where: { $0.id == id }), !title.isEmpty, !title.contains("\n"), !title.contains("\r") else { return text }
        return (text as NSString).replacingCharacters(in: entry.titleRange, with: title)
    }

    func removing(_ id: Int) -> String {
        guard let entry = entries.first(where: { $0.id == id }) else { return text }
        return (text as NSString).replacingCharacters(in: entry.fullRange, with: "")
    }
}

