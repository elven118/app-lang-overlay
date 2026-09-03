//
//  AppLangOverlayApp.swift
//  AppLangOverlay
//
//  Created by Elven Lau on 25/8/2026.
//

import SwiftData
import SwiftUI

@main
struct AppLangOverlayApp: App {
    @StateObject private var liveStore = LiveTranslationStore()
    @StateObject private var pip = PiPTranslationController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(liveStore)
                .environmentObject(pip)
        }
        .modelContainer(for: TranscriptEntry.self)
    }
}
