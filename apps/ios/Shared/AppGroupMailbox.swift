import Foundation

struct MailboxPayload: Codable, Sendable {
    let sequence: UInt64
    let connectionState: String?
    let result: TranslationResult?
    let clear: TranslationClear?
}

enum AppGroupMailbox {
    nonisolated static let notification = "com.local.AppLangOverlay.mailbox.changed" as CFString
    private static let filename = "translation-mailbox-v1.json"

    static func write(_ payload: MailboxPayload) throws {
        guard let root = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: AppSettings.appGroup
        ) else { throw MailboxError.appGroupUnavailable }
        let data = try JSONEncoder().encode(payload)
        try data.write(to: root.appendingPathComponent(filename), options: [.atomic])
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(notification), nil, nil, true
        )
    }

    static func read() -> MailboxPayload? {
        guard let root = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: AppSettings.appGroup
        ), let data = try? Data(contentsOf: root.appendingPathComponent(filename)) else { return nil }
        return try? JSONDecoder().decode(MailboxPayload.self, from: data)
    }

    enum MailboxError: Error { case appGroupUnavailable }
}
