import Foundation
import SwiftData

@Model
final class TranscriptEntry {
    @Attribute(.unique) var dedupeKey: String
    var frameId: String
    var sourceText: String
    var translatedText: String
    var sourceLanguage: String
    var targetLanguage: String
    var ocrProvider: String
    var createdAt: Date

    init(result: TranslationResult, settings: AppSettings) {
        dedupeKey = result.dedupeKey
        frameId = result.frameId
        sourceText = result.combinedSourceText
        translatedText = result.combinedTranslatedText
        sourceLanguage = settings.sourceLanguage.rawValue
        targetLanguage = settings.targetLanguage.rawValue
        ocrProvider = result.ocrProvider
        createdAt = .now
    }
}
