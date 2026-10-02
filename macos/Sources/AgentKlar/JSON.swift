import Foundation
import CoreFoundation

enum JSON: Sendable, Codable, Hashable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null

    subscript(_ key: String) -> JSON { objectValue?[key] ?? .null }
    var string: String? { if case .string(let value) = self { return value }; return nil }
    var array: [JSON]? { if case .array(let value) = self { return value }; return nil }
    var bool: Bool? { if case .bool(let value) = self { return value }; return nil }
    var number: Double? { if case .number(let value) = self { return value }; return nil }
    var objectValue: [String: JSON]? { if case .object(let value) = self { return value }; return nil }

    static func any(_ value: Any) -> JSON {
        switch value {
        case let value as String: return .string(value)
        case let value as NSNumber:
            return CFGetTypeID(value) == CFBooleanGetTypeID() ? .bool(value.boolValue) : .number(value.doubleValue)
        case let value as [String: Any]: return .object(value.mapValues(JSON.any))
        case let value as [Any]: return .array(value.map(JSON.any))
        default: return .null
        }
    }
    var any: Any {
        switch self {
        case .object(let value): return value.mapValues(\.any)
        case .array(let value): return value.map(\.any)
        case .string(let value): return value
        case .number(let value): return value
        case .bool(let value): return value
        case .null: return NSNull()
        }
    }
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([JSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}
