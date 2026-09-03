import CoreImage
import ImageIO
import ReplayKit
import UIKit
import Vision

final class SampleHandler: RPBroadcastSampleHandler {
    private let processingQueue = DispatchQueue(label: "com.local.AppLangOverlay.vision", qos: .userInitiated)
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let stream = ExtensionStreamClient()
    private var lastProcessedAt: CFTimeInterval = 0
    private var lastFingerprint: [UInt8] = []
    private var processing = false

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        stream.start()
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        stream.stop()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video, CMSampleBufferIsValid(sampleBuffer) else { return }
        let now = CACurrentMediaTime()
        guard now - lastProcessedAt >= 0.5, !processing else { return }
        lastProcessedAt = now
        processing = true
        processingQueue.async { [weak self] in
            defer { self?.processing = false }
            self?.processVideo(sampleBuffer)
        }
    }

    private func processVideo(_ sampleBuffer: CMSampleBuffer) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let orientation = sampleOrientation(sampleBuffer)
        let oriented = CIImage(cvPixelBuffer: pixelBuffer).oriented(forExifOrientation: Int32(orientation.rawValue))
        guard var image = ciContext.createCGImage(oriented, from: oriented.extent) else { return }
        if let crop = stream.settings.crop, let cropped = cropImage(image, normalized: crop) { image = cropped }
        guard isVisuallyChanged(image) else { return }

        let frameID = stream.nextFrameID()
        let capturedAt = UInt64(Date().timeIntervalSince1970 * 1000)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = recognitionLanguages(stream.settings.sourceLanguage)
        do {
            try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        } catch {
            sendFallbackOrEmpty(image, frameID: frameID, capturedAt: capturedAt)
            return
        }
        let observations = request.results ?? []
        let converted = observations.compactMap { observation -> (TextBlock, Int)? in
            guard let candidate = observation.topCandidates(1).first,
                  !candidate.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            let box = observation.boundingBox
            return (
                TextBlock(
                    id: "block-\(UUID().uuidString.prefix(8))",
                    text: candidate.string, confidence: Double(candidate.confidence),
                    rect: NormalizedRect(
                        x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height
                    ),
                    readingOrder: 0
                ),
                max(1, candidate.string.count)
            )
        }
        let ordered = readingOrder(converted.map(\.0), language: stream.settings.sourceLanguage)
        let totalWeight = converted.reduce(0) { $0 + $1.1 }
        let weightedConfidence = totalWeight == 0 ? 0 : converted.reduce(0.0) {
            $0 + $1.0.confidence * Double($1.1)
        } / Double(totalWeight)
        if !ordered.isEmpty, weightedConfidence >= 0.65 {
            stream.sendText(
                frameID: frameID, capturedAtMs: capturedAt,
                width: image.width, height: image.height, blocks: ordered
            )
        } else {
            sendFallbackOrEmpty(image, frameID: frameID, capturedAt: capturedAt)
        }
    }

    private func sendFallbackOrEmpty(_ image: CGImage, frameID: String, capturedAt: UInt64) {
        if stream.settings.imageUploadConsent,
           let resized = resize(image, maximumLongEdge: 1600),
           let jpeg = UIImage(cgImage: resized).jpegData(compressionQuality: 0.75) {
            stream.sendImage(
                frameID: frameID, capturedAtMs: capturedAt,
                width: resized.width, height: resized.height, jpeg: jpeg
            )
        } else {
            stream.sendText(
                frameID: frameID, capturedAtMs: capturedAt,
                width: image.width, height: image.height, blocks: []
            )
        }
    }

    private func sampleOrientation(_ sample: CMSampleBuffer) -> CGImagePropertyOrientation {
        guard let value = CMGetAttachment(
            sample, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil
        ) as? NSNumber else { return .up }
        return CGImagePropertyOrientation(rawValue: UInt32(value.uintValue)) ?? .up
    }

    private func recognitionLanguages(_ source: SourceLanguage) -> [String] {
        switch source {
        case .en: return ["en-US"]
        case .ja: return ["ja-JP"]
        case .ko: return ["ko-KR"]
        case .simplifiedChinese: return ["zh-Hans"]
        case .traditionalChinese: return ["zh-Hant"]
        case .auto: return []
        }
    }

    private func readingOrder(_ blocks: [TextBlock], language: SourceLanguage) -> [TextBlock] {
        let isCJK = language == .ja || language == .simplifiedChinese || language == .traditionalChinese
        let vertical = isCJK && blocks.filter { $0.rect.height > $0.rect.width * 1.35 }.count > blocks.count / 2
        let sorted = blocks.sorted { left, right in
            vertical ? (left.rect.x == right.rect.x ? left.rect.y < right.rect.y : left.rect.x > right.rect.x)
                     : (left.rect.y == right.rect.y ? left.rect.x < right.rect.x : left.rect.y < right.rect.y)
        }
        return sorted.enumerated().map { index, item in
            TextBlock(id: item.id, text: item.text, confidence: item.confidence,
                      rect: item.rect, readingOrder: index)
        }
    }

    private func cropImage(_ image: CGImage, normalized: NormalizedRect) -> CGImage? {
        let rect = CGRect(
            x: normalized.x * Double(image.width), y: normalized.y * Double(image.height),
            width: normalized.width * Double(image.width), height: normalized.height * Double(image.height)
        ).integral
        return image.cropping(to: rect)
    }

    private func resize(_ image: CGImage, maximumLongEdge: Int) -> CGImage? {
        let longest = max(image.width, image.height)
        guard longest > maximumLongEdge else { return image }
        let scale = Double(maximumLongEdge) / Double(longest)
        let width = max(1, Int(Double(image.width) * scale))
        let height = max(1, Int(Double(image.height) * scale))
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    private func isVisuallyChanged(_ image: CGImage) -> Bool {
        var bytes = [UInt8](repeating: 0, count: 16 * 16)
        guard let context = CGContext(
            data: &bytes, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 16,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return true }
        context.interpolationQuality = .low
        context.draw(image, in: CGRect(x: 0, y: 0, width: 16, height: 16))
        defer { lastFingerprint = bytes }
        guard lastFingerprint.count == bytes.count else { return true }
        let meanDelta = zip(bytes, lastFingerprint).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) } / bytes.count
        return meanDelta >= 3
    }
}
