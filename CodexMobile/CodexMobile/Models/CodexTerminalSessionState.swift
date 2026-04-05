// FILE: CodexTerminalSessionState.swift
// Purpose: Terminal session state mirrored from the local bridge for one thread-scoped shell session.
// Layer: Model
// Exports: CodexTerminalSessionState, CodexTerminalSessionPhase

import Foundation

enum CodexTerminalSessionPhase: String, Equatable, Sendable {
    case idle
    case opening
    case running
    case closed
    case failed
}

struct CodexTerminalSessionState: Equatable, Sendable {
    static let maxOutputCharacters = 40_000

    let threadID: String
    var sessionID: String?
    var sessionName: String
    var shellPath: String
    var workingDirectory: String?
    var output: String
    var phase: CodexTerminalSessionPhase
    var errorMessage: String?
    var lastExitCode: Int?
    var lastSignal: String?

    static func idle(threadID: String) -> CodexTerminalSessionState {
        CodexTerminalSessionState(
            threadID: threadID,
            sessionID: nil,
            sessionName: "Local terminal",
            shellPath: "/bin/zsh",
            workingDirectory: nil,
            output: "",
            phase: .idle,
            errorMessage: nil,
            lastExitCode: nil,
            lastSignal: nil
        )
    }

    var isRunning: Bool {
        phase == .opening || phase == .running
    }

    var statusLabel: String {
        switch phase {
        case .idle:
            return "Idle"
        case .opening:
            return "Starting"
        case .running:
            return "Live"
        case .closed:
            if let lastExitCode {
                return "Exited \(lastExitCode)"
            }
            return "Closed"
        case .failed:
            if let lastExitCode {
                return "Failed \(lastExitCode)"
            }
            return "Failed"
        }
    }

    mutating func appendOutputChunk(_ chunk: String) {
        let normalizedChunk = chunk.normalizedTerminalOutputChunk
        guard !normalizedChunk.isEmpty else {
            return
        }

        output += normalizedChunk
        trimOutputIfNeeded()
    }

    mutating func trimOutputIfNeeded() {
        guard output.count > Self.maxOutputCharacters else {
            return
        }

        output = String(output.suffix(Self.maxOutputCharacters))
    }
}

private extension String {
    var normalizedTerminalOutputChunk: String {
        let withoutANSI = replacingOccurrences(
            of: "\u{001B}\\[[0-9;?]*[ -/]*[@-~]",
            with: "",
            options: .regularExpression
        )

        return withoutANSI
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }
}
