// FILE: TurnTerminalPanel.swift
// Purpose: Presents a full-screen bridge-backed terminal panel that opens from the right side.
// Layer: View Component
// Exports: TurnTerminalPanel

import SwiftUI

struct TurnTerminalPanel: View {
    let threadID: String
    let threadTitle: String
    let workingDirectory: String?
    let onDismiss: () -> Void

    @Environment(CodexService.self) private var codex
    @State private var shellPath = "/bin/zsh"
    @State private var sessionName = "Local terminal"
    @State private var useProjectDirectory = true
    @State private var customWorkingDirectory = ""
    @State private var pendingInput = ""
    @State private var localErrorMessage: String?
    @State private var isOpeningSession = false
    @State private var isSendingInput = false
    @State private var isClosingSession = false
    @FocusState private var isInputFocused: Bool

    private var terminalState: CodexTerminalSessionState {
        codex.terminalSessionState(for: threadID)
    }

    private var resolvedWorkingDirectory: String {
        let trimmedCustomDirectory = customWorkingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        if !useProjectDirectory, !trimmedCustomDirectory.isEmpty {
            return trimmedCustomDirectory
        }

        return workingDirectory?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmptyValue
            ?? NSHomeDirectory()
    }

    private var sessionStatusTint: Color {
        switch terminalState.phase {
        case .running:
            return .green
        case .opening:
            return DesignTokens.Colors.glassAccent
        case .failed:
            return .red
        case .closed:
            return .orange
        case .idle:
            return .secondary
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            backgroundLayer

            VStack(spacing: 16) {
                header
                terminalCanvas
                if terminalState.isRunning {
                    terminalControls
                } else {
                    terminalSetupCard
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 16)
        }
        .ignoresSafeArea()
        .onAppear {
            if let workingDirectory, !workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                customWorkingDirectory = workingDirectory
            }
        }
    }

    private var backgroundLayer: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 9.0 / 255.0, green: 8.0 / 255.0, blue: 16.0 / 255.0),
                    Color(red: 14.0 / 255.0, green: 12.0 / 255.0, blue: 24.0 / 255.0),
                    DesignTokens.Colors.chatBackground,
                ],
                startPoint: .topTrailing,
                endPoint: .bottomLeading
            )

            Rectangle()
                .fill(DesignTokens.Colors.glassAccent.opacity(0.07))
                .blur(radius: 120)
                .offset(x: 120, y: -180)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Terminal")
                    .font(AppFont.title3(weight: .semibold))
                    .foregroundStyle(.primary)

                Text(threadTitle)
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                HStack(spacing: 8) {
                    Circle()
                        .fill(sessionStatusTint)
                        .frame(width: 8, height: 8)

                    Text(terminalState.statusLabel)
                        .font(AppFont.mono(.caption))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 12)

            Button(action: dismissPanel) {
                Image(systemName: "xmark")
                    .font(AppFont.system(size: 14, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .adaptiveGlass(in: Circle())
            .accessibilityLabel("Close terminal")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private var terminalCanvas: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if terminalState.output.isEmpty {
                        terminalPlaceholder
                    } else {
                        Text(terminalState.output)
                            .font(AppFont.mono(.body))
                            .foregroundStyle(Color.white.opacity(0.92))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("terminal-bottom")
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onAppear {
                scrollTerminalToBottom(proxy)
            }
            .onChange(of: terminalState.output) { _, _ in
                scrollTerminalToBottom(proxy)
            }
            .onChange(of: terminalState.phase) { _, _ in
                scrollTerminalToBottom(proxy)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 300)
        .background(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(Color.black.opacity(0.42))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    private var terminalPlaceholder: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("$ \(shellPath)")
            Text("cd \(resolvedWorkingDirectory)")
            Text(terminalState.phase == .failed ? "# \(terminalState.errorMessage ?? "Terminal failed to start.")" : "# Start a local shell session on your Mac.")
        }
        .font(AppFont.mono(.body))
        .foregroundStyle(Color.white.opacity(0.75))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var terminalSetupCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Setup")
                    .font(AppFont.headline(weight: .semibold))
                    .foregroundStyle(.primary)

                Text("Open one bridge-owned local shell session for this chat.")
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 10) {
                setupField(title: "Session name") {
                    TextField("Local terminal", text: $sessionName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                setupField(title: "Shell") {
                    TextField("/bin/zsh", text: $shellPath)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Toggle(isOn: $useProjectDirectory.animation(.easeInOut(duration: 0.18))) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Start in project directory")
                            .font(AppFont.body(weight: .medium))
                            .foregroundStyle(.primary)

                        Text(resolvedWorkingDirectory)
                            .font(AppFont.mono(.caption))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .tint(DesignTokens.Colors.glassAccent)

                if !useProjectDirectory {
                    setupField(title: "Working directory") {
                        TextField(NSHomeDirectory(), text: $customWorkingDirectory)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }

            if let errorMessage = localErrorMessage ?? terminalState.errorMessage {
                Text(errorMessage)
                    .font(AppFont.footnote())
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(action: startTerminalSession) {
                ZStack {
                    if isOpeningSession {
                        ProgressView()
                            .tint(.black)
                    } else {
                        Text("Start terminal")
                            .font(AppFont.body(weight: .semibold))
                            .foregroundStyle(.black)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 56)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isOpeningSession)
            .opacity(isOpeningSession ? 0.7 : 1)
        }
        .padding(18)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .animation(.easeInOut(duration: 0.18), value: useProjectDirectory)
    }

    private var terminalControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    terminalKeyButton("Tab") { sendRawInput("\t") }
                    terminalKeyButton("Esc") { sendRawInput("\u{001B}") }
                    terminalKeyButton("Up") { sendRawInput("\u{001B}[A") }
                    terminalKeyButton("Down") { sendRawInput("\u{001B}[B") }
                    terminalKeyButton("Left") { sendRawInput("\u{001B}[D") }
                    terminalKeyButton("Right") { sendRawInput("\u{001B}[C") }
                    terminalKeyButton("Ctrl+C") { sendRawInput("\u{0003}") }
                    terminalKeyButton("Ctrl+D") { sendRawInput("\u{0004}") }
                }
            }

            HStack(spacing: 10) {
                TextField("Type a command", text: $pendingInput)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(AppFont.mono(.body))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.white.opacity(0.05))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
                    )
                    .focused($isInputFocused)
                    .onSubmit {
                        sendPendingCommand()
                    }

                Button(action: sendPendingCommand) {
                    ZStack {
                        if isSendingInput {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.black)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(AppFont.system(size: 14, weight: .semibold))
                                .foregroundStyle(.black)
                        }
                    }
                    .frame(width: 48, height: 48)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isSendingInput)
                .opacity(isSendingInput ? 0.7 : 1)
            }

            HStack(spacing: 10) {
                Button(action: restartTerminalSession) {
                    Text("Restart")
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isOpeningSession || isClosingSession)

                Button(action: endTerminalSession) {
                    ZStack {
                        if isClosingSession {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.black)
                        } else {
                            Text("End session")
                                .font(AppFont.body(weight: .semibold))
                                .foregroundStyle(.black)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isClosingSession)
                .opacity(isClosingSession ? 0.7 : 1)
            }

            if let errorMessage = localErrorMessage ?? terminalState.errorMessage {
                Text(errorMessage)
                    .font(AppFont.footnote())
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(18)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private func setupField<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(AppFont.mono(.caption))
                .foregroundStyle(.secondary)

            content()
                .font(AppFont.mono(.body))
                .foregroundStyle(.primary)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
                )
        }
    }

    private func terminalKeyButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(AppFont.mono(.caption))
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!terminalState.isRunning)
        .opacity(terminalState.isRunning ? 1 : 0.5)
    }

    private func startTerminalSession() {
        localErrorMessage = nil
        isOpeningSession = true

        Task {
            do {
                try await codex.openTerminalSession(
                    forThreadID: threadID,
                    shellPath: shellPath,
                    workingDirectory: resolvedWorkingDirectory,
                    sessionName: sessionName
                )
                await MainActor.run {
                    isOpeningSession = false
                    isInputFocused = true
                }
            } catch {
                await MainActor.run {
                    localErrorMessage = error.localizedDescription
                    isOpeningSession = false
                }
            }
        }
    }

    private func restartTerminalSession() {
        Task {
            await codex.closeTerminalSession(forThreadID: threadID)
            await MainActor.run {
                localErrorMessage = nil
                startTerminalSession()
            }
        }
    }

    private func sendPendingCommand() {
        let command = pendingInput.trimmingCharacters(in: .newlines)
        guard !command.isEmpty else {
            return
        }

        pendingInput = ""
        sendRawInput("\(command)\n")
    }

    private func sendRawInput(_ text: String) {
        localErrorMessage = nil
        isSendingInput = true

        Task {
            do {
                try await codex.writeTerminalInput(forThreadID: threadID, text: text)
                await MainActor.run {
                    isSendingInput = false
                }
            } catch {
                await MainActor.run {
                    localErrorMessage = error.localizedDescription
                    isSendingInput = false
                }
            }
        }
    }

    private func endTerminalSession() {
        isClosingSession = true
        Task {
            await codex.closeTerminalSession(forThreadID: threadID)
            await MainActor.run {
                isClosingSession = false
            }
        }
    }

    private func dismissPanel() {
        Task {
            await codex.closeTerminalSession(forThreadID: threadID)
            await MainActor.run {
                codex.discardTerminalSessionState(forThreadID: threadID)
                onDismiss()
            }
        }
    }

    private func scrollTerminalToBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.12)) {
                proxy.scrollTo("terminal-bottom", anchor: .bottom)
            }
        }
    }
}

private extension String {
    var nonEmptyValue: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
