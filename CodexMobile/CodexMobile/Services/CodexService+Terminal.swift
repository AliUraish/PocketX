// FILE: CodexService+Terminal.swift
// Purpose: Opens, updates, writes to, and closes bridge-owned local terminal sessions.
// Layer: Service
// Exports: CodexService terminal helpers

import Foundation

extension CodexService {
    func terminalSessionState(for threadID: String) -> CodexTerminalSessionState {
        terminalSessionStateByThreadID[threadID] ?? .idle(threadID: threadID)
    }

    func openTerminalSession(
        forThreadID threadID: String,
        shellPath: String,
        workingDirectory: String?,
        sessionName: String
    ) async throws {
        let normalizedThreadID = threadID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedThreadID.isEmpty else {
            throw CodexServiceError.invalidInput("A thread id is required to open a terminal.")
        }

        var pendingState = terminalSessionState(for: normalizedThreadID)
        pendingState.phase = .opening
        pendingState.output = ""
        pendingState.errorMessage = nil
        pendingState.lastExitCode = nil
        pendingState.lastSignal = nil
        pendingState.shellPath = normalizedShellPath(shellPath)
        pendingState.workingDirectory = normalizedWorkingDirectory(workingDirectory)
        pendingState.sessionName = normalizedSessionName(sessionName)
        terminalSessionStateByThreadID[normalizedThreadID] = pendingState

        do {
            let response = try await sendRequest(
                method: "terminal/open",
                params: .object([
                    "threadId": .string(normalizedThreadID),
                    "shell": .string(pendingState.shellPath),
                    "sessionName": .string(pendingState.sessionName),
                    "cwd": .string(pendingState.workingDirectory ?? NSHomeDirectory()),
                ])
            )

            guard let resultObject = response.result?.objectValue else {
                throw CodexServiceError.invalidResponse("terminal/open response missing payload")
            }

            applyTerminalOpenedResult(resultObject, fallbackThreadID: normalizedThreadID)
        } catch {
            var failedState = terminalSessionState(for: normalizedThreadID)
            failedState.phase = .failed
            failedState.sessionID = nil
            failedState.errorMessage = terminalErrorMessage(from: error)
            terminalSessionStateByThreadID[normalizedThreadID] = failedState
            updateTerminalCompatibilityIfNeeded(from: error)
            throw error
        }
    }

    func writeTerminalInput(forThreadID threadID: String, text: String) async throws {
        let normalizedThreadID = threadID.trimmingCharacters(in: .whitespacesAndNewlines)
        let terminalText = text
        guard !terminalText.isEmpty else {
            return
        }

        let state = terminalSessionState(for: normalizedThreadID)
        guard let sessionID = state.sessionID, state.isRunning else {
            throw CodexServiceError.invalidInput("Start a terminal session before sending input.")
        }

        do {
            _ = try await sendRequest(
                method: "terminal/write",
                params: .object([
                    "threadId": .string(normalizedThreadID),
                    "sessionId": .string(sessionID),
                    "text": .string(terminalText),
                ])
            )
        } catch {
            updateTerminalCompatibilityIfNeeded(from: error)
            throw error
        }
    }

    func closeTerminalSession(forThreadID threadID: String) async {
        let normalizedThreadID = threadID.trimmingCharacters(in: .whitespacesAndNewlines)
        let state = terminalSessionState(for: normalizedThreadID)

        guard let sessionID = state.sessionID else {
            terminalSessionStateByThreadID.removeValue(forKey: normalizedThreadID)
            return
        }

        do {
            _ = try await sendRequest(
                method: "terminal/close",
                params: .object([
                    "threadId": .string(normalizedThreadID),
                    "sessionId": .string(sessionID),
                ])
            )
        } catch {
            updateTerminalCompatibilityIfNeeded(from: error)
        }

        var closedState = terminalSessionState(for: normalizedThreadID)
        closedState.phase = .closed
        closedState.sessionID = nil
        terminalSessionStateByThreadID[normalizedThreadID] = closedState
    }

    func discardTerminalSessionState(forThreadID threadID: String) {
        terminalSessionStateByThreadID.removeValue(forKey: threadID)
    }

    func handleTerminalOutputNotification(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let threadID = firstStringValue(in: paramsObject, keys: ["threadId", "thread_id"]) else {
            return
        }

        var state = terminalSessionState(for: threadID)
        let incomingSessionID = firstStringValue(in: paramsObject, keys: ["sessionId", "session_id"])
        if let currentSessionID = state.sessionID,
           let incomingSessionID,
           currentSessionID != incomingSessionID {
            return
        }
        if let incomingSessionID {
            state.sessionID = incomingSessionID
        }
        if let text = paramsObject["text"]?.stringValue {
            state.appendOutputChunk(text)
        }
        if state.phase == .idle || state.phase == .opening {
            state.phase = .running
        }
        state.errorMessage = nil
        terminalSessionStateByThreadID[threadID] = state
    }

    func handleTerminalClosedNotification(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let threadID = firstStringValue(in: paramsObject, keys: ["threadId", "thread_id"]) else {
            return
        }

        var state = terminalSessionState(for: threadID)
        let incomingSessionID = firstStringValue(in: paramsObject, keys: ["sessionId", "session_id"])
        if let currentSessionID = state.sessionID,
           let incomingSessionID,
           currentSessionID != incomingSessionID {
            return
        }
        state.sessionID = nil
        state.lastExitCode = firstIntValue(in: paramsObject, keys: ["exitCode", "exit_code"])
        state.lastSignal = firstStringValue(in: paramsObject, keys: ["signal"])
        state.errorMessage = firstStringValue(in: paramsObject, keys: ["errorMessage", "error_message"])
        state.phase = state.errorMessage == nil && (state.lastExitCode ?? 0) == 0 ? .closed : .failed
        terminalSessionStateByThreadID[threadID] = state
    }

    private func applyTerminalOpenedResult(
        _ payloadObject: IncomingParamsObject,
        fallbackThreadID: String
    ) {
        let threadID = firstStringValue(in: payloadObject, keys: ["threadId", "thread_id"]) ?? fallbackThreadID
        var state = terminalSessionState(for: threadID)
        state.sessionID = firstStringValue(in: payloadObject, keys: ["sessionId", "session_id"])
        state.sessionName = firstStringValue(in: payloadObject, keys: ["sessionName", "session_name"])
            ?? state.sessionName
        state.shellPath = firstStringValue(in: payloadObject, keys: ["shell"]) ?? state.shellPath
        state.workingDirectory = firstStringValue(in: payloadObject, keys: ["cwd", "workingDirectory", "working_directory"])
            ?? state.workingDirectory
        state.phase = .running
        state.errorMessage = nil
        terminalSessionStateByThreadID[threadID] = state
    }

    private func normalizedShellPath(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "/bin/zsh" : trimmed
    }

    private func normalizedWorkingDirectory(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func normalizedSessionName(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Local terminal" : trimmed
    }

    private func terminalErrorMessage(from error: Error) -> String {
        if let serviceError = error as? CodexServiceError {
            switch serviceError {
            case .rpcError(let rpcError):
                return rpcError.message
            default:
                return serviceError.localizedDescription
            }
        }

        return error.localizedDescription
    }

    private func updateTerminalCompatibilityIfNeeded(from error: Error) {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return
        }

        if rpcError.code == -32601 || rpcError.message.localizedCaseInsensitiveContains("terminal/") {
            supportsBridgeTerminalSessions = false
        }
    }
}
