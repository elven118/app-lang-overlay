import AVFoundation
import AVKit
import Combine
import CoreMedia
import SwiftUI
import UIKit

@MainActor
final class PiPTranslationController: NSObject, ObservableObject, AVPictureInPictureSampleBufferPlaybackDelegate {
    let displayLayer = AVSampleBufferDisplayLayer()
    @Published private(set) var isActive = false
    private var controller: AVPictureInPictureController?
    private var currentResult: TranslationResult?

    override init() {
        super.init()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = UIColor.black.cgColor
        if AVPictureInPictureController.isPictureInPictureSupported() {
            let source = AVPictureInPictureController.ContentSource(
                sampleBufferDisplayLayer: displayLayer,
                playbackDelegate: self
            )
            controller = AVPictureInPictureController(contentSource: source)
            controller?.canStartPictureInPictureAutomaticallyFromInline = true
        }
        render(nil)
    }

    func update(_ result: TranslationResult?) {
        currentResult = result
        render(result)
    }

    func toggle() {
        if controller?.isPictureInPictureActive == true {
            controller?.stopPictureInPicture()
            isActive = false
        } else {
            render(currentResult)
            controller?.startPictureInPicture()
            isActive = true
        }
    }

    private func render(_ result: TranslationResult?) {
        let width = 960
        let height = 540
        var buffer: CVPixelBuffer?
        let attributes: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                                  attributes as CFDictionary, &buffer) == kCVReturnSuccess,
              let buffer else { return }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return }
        context.setFillColor(UIColor(red: 0.035, green: 0.045, blue: 0.06, alpha: 1).cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byWordWrapping
        let source = result?.combinedSourceText ?? "Start a screen broadcast to translate"
        let translation = result?.combinedTranslatedText ?? ""
        let sourceText = NSAttributedString(string: source, attributes: [
            .font: UIFont.systemFont(ofSize: 36, weight: .medium),
            .foregroundColor: UIColor.white,
            .paragraphStyle: paragraph,
        ])
        let translatedText = NSAttributedString(string: translation, attributes: [
            .font: UIFont.systemFont(ofSize: 42, weight: .semibold),
            .foregroundColor: UIColor(red: 1, green: 0.82, blue: 0.35, alpha: 1),
            .paragraphStyle: paragraph,
        ])
        UIGraphicsPushContext(context)
        sourceText.draw(in: CGRect(x: 60, y: 90, width: 840, height: 170))
        translatedText.draw(in: CGRect(x: 60, y: 285, width: 840, height: 170))
        UIGraphicsPopContext()

        var description: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &description
        ) == noErr, let description else { return }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
            decodeTimeStamp: .invalid
        )
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer,
            formatDescription: description, sampleTiming: &timing, sampleBufferOut: &sample
        ) == noErr, let sample else { return }
        if displayLayer.status == .failed { displayLayer.flush() }
        displayLayer.enqueue(sample)
    }

    nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {}
    nonisolated func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
        CMTimeRange(start: .zero, duration: .positiveInfinity)
    }
    nonisolated func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool { false }
    nonisolated func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        didTransitionToRenderSize newRenderSize: CMVideoDimensions
    ) {}
    nonisolated func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        skipByInterval skipInterval: CMTime,
        completion completionHandler: @escaping @Sendable () -> Void
    ) { completionHandler() }
}

struct PiPPanelView: UIViewRepresentable {
    let layer: AVSampleBufferDisplayLayer

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        view.layer.addSublayer(layer)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        if layer.superlayer !== uiView.layer {
            layer.removeFromSuperlayer()
            uiView.layer.addSublayer(layer)
        }
        layer.frame = uiView.bounds
    }
}
