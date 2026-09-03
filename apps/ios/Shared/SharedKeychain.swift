import Foundation
import Security

enum SharedKeychain {
    private static let service = "com.local.AppLangOverlay.backend"
    private static let account = "bearer-token"
    private static let accessGroup = "8H5LKJ5VT5.com.local.AppLangOverlay.shared"

    static func readToken() -> String {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrAccessGroup: accessGroup,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    static func saveToken(_ token: String) throws {
        let identity: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrAccessGroup: accessGroup,
        ]
        SecItemDelete(identity as CFDictionary)
        guard !token.isEmpty else { return }
        var value = identity
        value[kSecValueData] = Data(token.utf8)
        value[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(value as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    enum KeychainError: Error { case status(OSStatus) }
}
