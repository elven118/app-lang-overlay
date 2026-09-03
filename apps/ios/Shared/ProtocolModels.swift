import Foundation

enum SourceLanguage: String, Codable, CaseIterable, Identifiable, Sendable {
    case auto, en, ja, ko
    case simplifiedChinese = "zh-Hans"
    case traditionalChinese = "zh-Hant"

    var id: String { rawValue }
}

enum TargetLanguage: String, Codable, CaseIterable, Identifiable, Sendable {
    case en
    case traditionalChinese = "zh-Hant"

    var id: String { rawValue }
}

struct NormalizedRect: Codable, Hashable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct TextBlock: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let text: String
    let confidence: Double
    let rect: NormalizedRect
    let readingOrder: Int
}

struct TranslationBlock: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let text: String
    let confidence: Double
    let rect: NormalizedRect
    let readingOrder: Int
    let translatedText: String
}

struct TranslationTiming: Codable, Hashable, Sendable {
    let ocr: Double
    let translation: Double
    let total: Double
}

struct TranslationResult: Codable, Hashable, Sendable {
    let type: String
    let sessionId: String
    let frameId: String
    let ocrProvider: String
    let blocks: [TranslationBlock]
    let combinedSourceText: String
    let combinedTranslatedText: String
    let dedupeKey: String
    let timingMs: TranslationTiming
}

struct TranslationClear: Codable, Hashable, Sendable {
    let type: String
    let sessionId: String
    let frameId: String
    let reason: String
}

struct ErrorMessage: Codable, Sendable {
    let type: String
    let code: String
    let message: String
    let retryable: Bool
    let requestId: String?
    let frameId: String?
}

struct StreamMessage: Decodable, Sendable {
    let type: String
    let sessionId: String?
    let result: TranslationResult?
    let clear: TranslationClear?

    private enum CodingKeys: String, CodingKey { case type, sessionId }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        switch type {
        case "translation.result":
            result = try TranslationResult(from: decoder)
            clear = nil
        case "translation.clear":
            result = nil
            clear = try TranslationClear(from: decoder)
        default:
            result = nil
            clear = nil
        }
    }
}

struct ImageEnvelopeHeader: Encodable, Sendable {
    let type = "frame.image"
    let sessionId: String
    let frameId: String
    let capturedAtMs: UInt64
    let sourceLanguage: String
    let imageWidth: Int
    let imageHeight: Int
    let crop: NormalizedRect?
    let mimeType = "image/jpeg"
    let clientOcrDiagnostics: [String: String]
}

enum BinaryEnvelope {
    static func encode(header: ImageEnvelopeHeader, jpeg: Data) throws -> Data {
        let headerData = try JSONEncoder().encode(header)
        guard headerData.count <= 64 * 1024 else { throw EnvelopeError.headerTooLarge }
        guard jpeg.count <= 4 * 1024 * 1024 else { throw EnvelopeError.imageTooLarge }
        var output = Data("ALO1".utf8)
        var size = UInt32(headerData.count).bigEndian
        withUnsafeBytes(of: &size) { output.append(contentsOf: $0) }
        output.append(headerData)
        output.append(jpeg)
        return output
    }

    enum EnvelopeError: Error { case headerTooLarge, imageTooLarge }
}
