import Foundation

struct AppSettings: Codable, Equatable, Sendable {
    var endpoint = "ws://127.0.0.1:8765/v1/stream"
    var sourceLanguage: SourceLanguage = .ja
    var targetLanguage: TargetLanguage = .traditionalChinese
    var imageUploadConsent = false
    var crop: NormalizedRect?

    static let appGroup = "group.com.local.AppLangOverlay"
    private static let defaultsKey = "settings.v1"

    static func load() -> AppSettings {
        guard
            let defaults = UserDefaults(suiteName: appGroup),
            let data = defaults.data(forKey: defaultsKey),
            let value = try? JSONDecoder().decode(AppSettings.self, from: data)
        else { return AppSettings() }
        return value
    }

    func save() throws {
        let data = try JSONEncoder().encode(self)
        UserDefaults(suiteName: Self.appGroup)?.set(data, forKey: Self.defaultsKey)
    }
}
