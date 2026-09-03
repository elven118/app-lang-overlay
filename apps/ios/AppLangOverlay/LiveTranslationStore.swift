import Combine
import Foundation

private let mailboxCallback: CFNotificationCallback = { _, observer, _, _, _ in
    guard let observer else { return }
    let store = Unmanaged<LiveTranslationStore>.fromOpaque(observer).takeUnretainedValue()
    DispatchQueue.main.async { store.consumeMailbox() }
}

@MainActor
final class LiveTranslationStore: ObservableObject {
    @Published var settings = AppSettings.load()
    @Published var token = SharedKeychain.readToken()
    @Published private(set) var latestResult: TranslationResult?
    @Published private(set) var connectionState = "offline"
    @Published var settingsError: String?
    private var lastSequence: UInt64 = 0

    init() {
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), observer, mailboxCallback,
            AppGroupMailbox.notification, nil, .deliverImmediately
        )
        consumeMailbox()
    }

    deinit {
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            CFNotificationName(AppGroupMailbox.notification), nil
        )
    }

    func consumeMailbox() {
        guard let payload = AppGroupMailbox.read(), payload.sequence > lastSequence else { return }
        lastSequence = payload.sequence
        if let state = payload.connectionState { connectionState = state }
        if let result = payload.result { latestResult = result }
        if payload.clear != nil { latestResult = nil }
    }

    func saveSettings() {
        do {
            try settings.save()
            try SharedKeychain.saveToken(token)
            settingsError = nil
        } catch {
            settingsError = error.localizedDescription
        }
    }
}
