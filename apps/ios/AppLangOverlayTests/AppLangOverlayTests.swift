import Foundation
import Testing
@testable import AppLangOverlay

private final class FixtureBundleToken {}

struct AppLangOverlayTests {
    @Test func canonicalTranslationFixtureDecodes() throws {
        let bundle = Bundle(for: FixtureBundleToken.self)
        let url = try #require(bundle.url(forResource: "translation.result", withExtension: "json"))
        let result = try JSONDecoder().decode(TranslationResult.self, from: Data(contentsOf: url))
        #expect(result.frameId == "42")
        #expect(result.blocks.first?.translatedText == "今天")
        #expect(result.blocks.first?.rect.x == 0.1)
    }

    @Test func binaryEnvelopeUsesALO1AndBigEndianHeaderLength() throws {
        let header = ImageEnvelopeHeader(
            sessionId: "ios-test", frameId: "7", capturedAtMs: 1,
            sourceLanguage: "ja", imageWidth: 100, imageHeight: 50,
            crop: nil, clientOcrDiagnostics: ["provider": "vision"]
        )
        let data = try BinaryEnvelope.encode(header: header, jpeg: Data([0xff, 0xd8]))
        #expect(String(decoding: data.prefix(4), as: UTF8.self) == "ALO1")
        let length = data[4..<8].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        #expect(length > 0)
        #expect(data.count == 8 + Int(length) + 2)
    }
}
