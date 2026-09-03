import SwiftData
import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            LiveView()
                .tabItem { Label("Live", systemImage: "captions.bubble") }
            HistoryView()
                .tabItem { Label("History", systemImage: "clock") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

private struct LiveView: View {
    @Environment(\.modelContext) private var modelContext
    @EnvironmentObject private var store: LiveTranslationStore
    @EnvironmentObject private var pip: PiPTranslationController

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    HStack {
                        Circle()
                            .fill(store.connectionState == "online" ? .green : .orange)
                            .frame(width: 10, height: 10)
                        Text(store.connectionState.capitalized)
                            .foregroundStyle(.secondary)
                        Spacer()
                        BroadcastPicker()
                            .frame(width: 52, height: 52)
                            .accessibilityLabel("Start screen broadcast")
                    }

                    PiPPanelView(layer: pip.displayLayer)
                        .frame(height: 210)
                        .clipShape(RoundedRectangle(cornerRadius: 16))

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Source").font(.caption).foregroundStyle(.secondary)
                        Text(store.latestResult?.combinedSourceText ?? "Waiting for text…")
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Divider()
                        Text("Translation").font(.caption).foregroundStyle(.secondary)
                        Text(store.latestResult?.combinedTranslatedText ?? "—")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.yellow)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding()
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))

                    Button(pip.isActive ? "Stop Picture in Picture" : "Start Picture in Picture") {
                        pip.toggle()
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding()
            }
            .navigationTitle("Live Translation")
            .onChange(of: store.latestResult) { _, result in
                pip.update(result)
                guard let result else { return }
                modelContext.insert(TranscriptEntry(result: result, settings: store.settings))
                try? modelContext.save()
            }
        }
    }
}

private struct HistoryView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \TranscriptEntry.createdAt, order: .reverse) private var entries: [TranscriptEntry]

    var body: some View {
        NavigationStack {
            List {
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(entry.sourceText).font(.body)
                        Text(entry.translatedText).foregroundStyle(.secondary)
                        Text(entry.createdAt, format: .dateTime.month().day().hour().minute())
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                .onDelete { offsets in
                    offsets.map { entries[$0] }.forEach(modelContext.delete)
                }
            }
            .navigationTitle("History")
            .overlay {
                if entries.isEmpty {
                    ContentUnavailableView("No Translations", systemImage: "text.bubble")
                }
            }
        }
    }
}

private struct SettingsView: View {
    @EnvironmentObject private var store: LiveTranslationStore

    var body: some View {
        NavigationStack {
            Form {
                Section("Backend") {
                    TextField("wss://server.example/v1/stream", text: $store.settings.endpoint)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    SecureField("Bearer token", text: $store.token)
                    Text("Restart an active screen broadcast after changing backend settings.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Languages") {
                    Picker("Source", selection: $store.settings.sourceLanguage) {
                        ForEach(SourceLanguage.allCases) { Text($0.rawValue).tag($0) }
                    }
                    Picker("Target", selection: $store.settings.targetLanguage) {
                        ForEach(TargetLanguage.allCases) { Text($0.rawValue).tag($0) }
                    }
                }
                Section("Image fallback") {
                    Toggle("Allow low-confidence frame uploads", isOn: $store.settings.imageUploadConsent)
                    Text("Frames are sent transiently only when Vision OCR confidence is below 0.65. Images are not saved to history.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error = store.settingsError {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Button("Save Settings") { store.saveSettings() }
            }
            .navigationTitle("Settings")
        }
    }
}
