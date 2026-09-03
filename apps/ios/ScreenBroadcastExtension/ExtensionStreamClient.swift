import Foundation

final class ExtensionStreamClient: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.local.AppLangOverlay.stream")
    private var task: URLSessionWebSocketTask?
    private var running = false
    private var ready = false
    private var reconnectAttempt = 0
    private var sessionID = ""
    private var frameID: UInt64 = 0
    private var mailboxSequence: UInt64 = 0
    private let reconnectDelays: [TimeInterval] = [1, 2, 4, 8, 15]
    private(set) var settings = AppSettings.load()

    func start() {
        queue.async {
            self.running = true
            self.settings = AppSettings.load()
            self.connect()
        }
    }

    func stop() {
        queue.async {
            self.running = false
            if self.ready {
                self.sendJSON(["type": "session.end", "sessionId": self.sessionID])
            }
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.ready = false
            self.publish(state: "offline")
        }
    }

    func nextFrameID() -> String {
        queue.sync {
            frameID &+= 1
            return String(frameID)
        }
    }

    func sendText(frameID: String, capturedAtMs: UInt64, width: Int, height: Int, blocks: [TextBlock]) {
        queue.async {
            guard self.ready else { return }
            let encodedBlocks = blocks.map { block -> [String: Any] in
                [
                    "id": block.id,
                    "text": block.text,
                    "confidence": block.confidence,
                    "rect": [
                        "x": block.rect.x, "y": block.rect.y,
                        "width": block.rect.width, "height": block.rect.height,
                    ],
                    "readingOrder": block.readingOrder,
                ]
            }
            self.sendJSON([
                "type": "frame.text", "sessionId": self.sessionID, "frameId": frameID,
                "capturedAtMs": capturedAtMs, "imageWidth": width, "imageHeight": height,
                "blocks": encodedBlocks,
            ])
        }
    }

    func sendImage(frameID: String, capturedAtMs: UInt64, width: Int, height: Int, jpeg: Data) {
        queue.async {
            guard self.ready, self.settings.imageUploadConsent else { return }
            let header = ImageEnvelopeHeader(
                sessionId: self.sessionID, frameId: frameID, capturedAtMs: capturedAtMs,
                sourceLanguage: self.settings.sourceLanguage.rawValue,
                imageWidth: width, imageHeight: height, crop: nil,
                clientOcrDiagnostics: ["provider": "vision", "reason": "low-confidence"]
            )
            guard let envelope = try? BinaryEnvelope.encode(header: header, jpeg: jpeg) else { return }
            self.task?.send(.data(envelope)) { [weak self] error in
                if error != nil { self?.connectionFailed() }
            }
        }
    }

    private func connect() {
        guard running, task == nil else { return }
        guard let url = secureURL(settings.endpoint) else {
            publish(state: "error")
            scheduleReconnect()
            return
        }
        var request = URLRequest(url: url)
        let token = SharedKeychain.readToken()
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        sessionID = "ios-\(UUID().uuidString.lowercased())"
        ready = false
        publish(state: "connecting")
        let socket = URLSession(configuration: .ephemeral).webSocketTask(with: request)
        task = socket
        socket.resume()
        sendJSON([
            "type": "client.hello", "protocolVersion": 1, "clientKind": "ios",
            "appVersion": "0.3.0", "capabilities": ["vision-ocr", "paddle-fallback", "replaykit"],
        ])
        receive()
    }

    private func secureURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss" else { return nil }
        if scheme == "ws" {
            let host = url.host?.lowercased() ?? ""
            let privateLAN = host == "localhost" || host == "127.0.0.1" || host == "::1" ||
                host.hasPrefix("10.") || host.hasPrefix("192.168.") || host.hasSuffix(".local") ||
                (host.hasPrefix("172.") && (16...31).contains(Int(host.split(separator: ".").dropFirst().first ?? "") ?? -1))
            guard privateLAN else { return nil }
        }
        return url
    }

    private func sendJSON(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { [weak self] error in
            if error != nil { self?.connectionFailed() }
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                switch result {
                case .failure:
                    self.connectionFailed()
                case .success(let message):
                    let data: Data
                    switch message {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let value): data = value
                    @unknown default: self.receive(); return
                    }
                    self.handle(data)
                    self.receive()
                }
            }
        }
    }

    private func handle(_ data: Data) {
        guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = raw["type"] as? String else { return }
        if type == "server.ready" {
            sendJSON([
                "type": "session.start", "sessionId": sessionID,
                "sourceLanguage": settings.sourceLanguage.rawValue,
                "targetLanguage": settings.targetLanguage.rawValue,
                "ocrMode": "hybrid", "imageUploadConsent": settings.imageUploadConsent,
                "crop": NSNull(),
            ])
        } else if type == "session.state" {
            ready = true
            reconnectAttempt = 0
            publish(state: "online")
        } else if type == "translation.result",
                  let result = try? JSONDecoder().decode(TranslationResult.self, from: data) {
            publish(result: result)
        } else if type == "translation.clear",
                  let clear = try? JSONDecoder().decode(TranslationClear.self, from: data) {
            publish(clear: clear)
        } else if type == "error" {
            publish(state: "error")
        }
    }

    private func connectionFailed() {
        queue.async {
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.ready = false
            self.publish(state: "offline")
            self.scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard running else { return }
        let delay = reconnectDelays[min(reconnectAttempt, reconnectDelays.count - 1)]
        reconnectAttempt += 1
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }

    private func publish(state: String? = nil, result: TranslationResult? = nil, clear: TranslationClear? = nil) {
        let wallClockSequence = UInt64(Date().timeIntervalSince1970 * 1_000_000)
        mailboxSequence = max(mailboxSequence &+ 1, wallClockSequence)
        try? AppGroupMailbox.write(
            MailboxPayload(sequence: mailboxSequence, connectionState: state, result: result, clear: clear)
        )
    }
}
