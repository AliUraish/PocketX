// FILE: CodexService+BridgeProtocol.swift
// Purpose: Negotiates and uses the bridge-owned mobile protocol facade over raw Codex RPC methods.
// Layer: Service
// Exports: CodexService bridge protocol helpers plus health snapshot model
// Depends on: Foundation, RPCMessage, JSONValue

import Foundation

enum CodexBridgeProtocolAvailability: Equatable, Sendable {
    case unknown
    case unsupported
    case available(version: Int)
}

struct CodexBridgeHealthSnapshot: Equatable, Sendable {
    let status: String
    let bridgeState: String?
    let relayConnectionStatus: String?
    let codexConnectionStatus: String?
    let codexHandshakeState: String?
    let pendingApprovalCount: Int
    let lastError: String?
    let pairingCodeActive: Bool
    let pairingCodeExpiresAt: Int?
    let lastRelayActivityAt: Int?
    let relayHeartbeatStale: Bool
    let canReconnect: Bool
    let bridgeVersion: String?
    let bridgeLatestVersion: String?
}

private struct CodexBridgeDiagnosticEnvelope: Equatable, Sendable {
    let events: [CodexBridgeDiagnosticEvent]
}

private struct CodexBridgeEnvelope {
    let event: String?
    let rawMethod: String?
    let rawParams: JSONValue?
}

extension CodexService {
    static let bridgeProtocolVersion = 1

    var isBridgeProtocolAvailable: Bool {
        if case .available = bridgeProtocolAvailability {
            return true
        }
        return false
    }

    func bridgeProtocolMethodName(for rawMethod: String) -> String? {
        switch rawMethod {
        case "thread/start":
            return "bridge/thread/start"
        case "thread/list":
            return "bridge/thread/list"
        case "thread/read":
            return "bridge/thread/read"
        case "thread/resume":
            return "bridge/thread/resume"
        case "thread/fork":
            return "bridge/thread/fork"
        case "model/list":
            return "bridge/model/list"
        case "collaborationMode/list":
            return "bridge/collaborationMode/list"
        case "turn/start":
            return "bridge/turn/start"
        case "turn/steer":
            return "bridge/turn/steer"
        case "turn/interrupt":
            return "bridge/turn/interrupt"
        default:
            return nil
        }
    }

    func sendBridgeCompatibleRequest(method rawMethod: String, params: JSONValue?) async throws -> RPCMessage {
        guard let bridgeMethod = bridgeProtocolMethodName(for: rawMethod),
              isBridgeProtocolAvailable else {
            return try await sendRequest(method: rawMethod, params: params)
        }

        do {
            return try await sendRequest(method: bridgeMethod, params: params)
        } catch {
            guard shouldTreatAsUnsupportedBridgeProtocol(error) else {
                throw error
            }

            bridgeProtocolAvailability = .unsupported
            bridgeHealthSnapshot = nil
            return try await sendRequest(method: rawMethod, params: params)
        }
    }

    func refreshBridgeProtocolState() async {
        await refreshBridgeProtocolAvailability()
        await refreshBridgeHealthState()
    }

    func refreshConnectionDiagnostics(allowAvailableBridgeUpdatePrompt: Bool = false) async {
        guard isConnected else {
            bridgeHealthSnapshot = nil
            applyGPTAccountConnectionFallback()
            clearPendingApprovals()
            return
        }

        await refreshBridgeProtocolState()
        await refreshPendingApprovals()
        await refreshBridgeDiagnostics()
        await refreshBridgeManagedState(allowAvailableBridgeUpdatePrompt: allowAvailableBridgeUpdatePrompt)
    }

    func refreshBridgeProtocolAvailability() async {
        guard isConnected else {
            bridgeProtocolAvailability = .unknown
            bridgeHealthSnapshot = nil
            bridgeCodexVersion = nil
            return
        }

        do {
            let response = try await sendRequest(method: "bridge/capabilities", params: nil)
            guard let payloadObject = response.result?.objectValue else {
                throw CodexServiceError.invalidResponse("bridge/capabilities response missing payload")
            }

            let negotiatedVersion = payloadObject["bridgeProtocolVersion"]?.intValue
                ?? payloadObject["bridge_protocol_version"]?.intValue
                ?? 0
            if negotiatedVersion > 0 {
                bridgeProtocolAvailability = .available(version: negotiatedVersion)
            } else {
                bridgeProtocolAvailability = .unsupported
            }

            applyBridgeCapabilitySnapshot(from: payloadObject)
        } catch {
            if shouldTreatAsUnsupportedBridgeProtocol(error) {
                bridgeProtocolAvailability = .unsupported
                bridgeHealthSnapshot = nil
                bridgeCodexVersion = nil
            } else {
                bridgeProtocolAvailability = .unknown
            }
        }
    }

    func refreshBridgeHealthState() async {
        guard isConnected, isBridgeProtocolAvailable else {
            bridgeHealthSnapshot = nil
            return
        }

        do {
            let response = try await sendRequest(method: "bridge/health", params: nil)
            guard let payloadObject = response.result?.objectValue else {
                throw CodexServiceError.invalidResponse("bridge/health response missing payload")
            }
            let previousHealthState = bridgeHealthState
            applyBridgeHealthSnapshot(from: payloadObject)
            let nextHealthState = bridgeHealthState
            notifyBridgeHealthTransitionIfNeeded(from: previousHealthState, to: nextHealthState)
        } catch {
            if shouldTreatAsUnsupportedBridgeProtocol(error) {
                bridgeProtocolAvailability = .unsupported
            }
            bridgeHealthSnapshot = nil
        }
    }

    func refreshPendingApprovals() async {
        guard isConnected else {
            clearPendingApprovals()
            return
        }

        guard isBridgeProtocolAvailable else {
            return
        }

        do {
            let response = try await sendRequest(method: "bridge/approval/list", params: nil)
            let approvals = decodeBridgeApprovalRequests(from: response.result?.objectValue)
            replacePendingApprovals(approvals)
        } catch {
            if shouldTreatAsUnsupportedBridgeProtocol(error) {
                bridgeProtocolAvailability = .unsupported
            }
        }
    }

    func refreshBridgeDiagnostics(limit: Int = 25) async {
        guard isConnected else {
            bridgeDiagnosticEvents = []
            return
        }

        guard isBridgeProtocolAvailable else {
            return
        }

        do {
            let response = try await sendRequest(
                method: "bridge/diagnostics/read",
                params: .object([
                    "limit": .integer(max(1, min(limit, 100))),
                ])
            )
            let diagnostics = decodeBridgeDiagnosticEnvelope(from: response.result?.objectValue)
            bridgeDiagnosticEvents = diagnostics.events
        } catch {
            if shouldTreatAsUnsupportedBridgeProtocol(error) {
                bridgeProtocolAvailability = .unsupported
            }
        }
    }

    func handleBridgeRequestEnvelope(
        requestID: JSONValue,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        guard let envelope = decodeBridgeEnvelope(from: paramsObject),
              let rawMethod = envelope.rawMethod else {
            return false
        }

        handleServerRequest(
            method: normalizedIncomingMethodName(rawMethod),
            requestID: requestID,
            params: envelope.rawParams
        )
        return true
    }

    func handleBridgeEventEnvelope(_ paramsObject: IncomingParamsObject?) -> Bool {
        guard let envelope = decodeBridgeEnvelope(from: paramsObject) else {
            return false
        }

        if let rawMethod = envelope.rawMethod {
            handleNotification(
                method: normalizedIncomingMethodName(rawMethod),
                params: envelope.rawParams
            )
            return true
        }

        if envelope.event == "bridge.healthChanged",
           let snapshotObject = envelope.rawParams?.objectValue {
            applyBridgeHealthSnapshot(from: snapshotObject)
            return true
        }

        return false
    }

    func applyBridgeHealthSnapshot(from payloadObject: IncomingParamsObject) {
        bridgeInstalledVersion = firstStringValue(
            in: payloadObject,
            keys: ["bridgeVersion", "bridge_version", "bridgePackageVersion", "bridge_package_version"]
        )
        latestBridgePackageVersion = firstStringValue(
            in: payloadObject,
            keys: ["bridgeLatestVersion", "bridge_latest_version", "bridgePublishedVersion", "bridge_published_version"]
        )

        bridgeHealthSnapshot = CodexBridgeHealthSnapshot(
            status: firstStringValue(in: payloadObject, keys: ["status"]) ?? "unknown",
            bridgeState: firstStringValue(in: payloadObject, keys: ["bridgeState", "bridge_state"]),
            relayConnectionStatus: firstStringValue(
                in: payloadObject,
                keys: ["relayConnectionStatus", "relay_connection_status"]
            ),
            codexConnectionStatus: firstStringValue(
                in: payloadObject,
                keys: ["codexConnectionStatus", "codex_connection_status"]
            ),
            codexHandshakeState: firstStringValue(
                in: payloadObject,
                keys: ["codexHandshakeState", "codex_handshake_state"]
            ),
            pendingApprovalCount: firstIntValue(
                in: payloadObject,
                keys: ["pendingApprovalCount", "pending_approval_count"]
            ) ?? 0,
            lastError: firstStringValue(in: payloadObject, keys: ["lastError", "last_error"]),
            pairingCodeActive: firstBoolValue(in: payloadObject, keys: ["pairingCodeActive", "pairing_code_active"]) ?? false,
            pairingCodeExpiresAt: firstIntValue(
                in: payloadObject,
                keys: ["pairingCodeExpiresAt", "pairing_code_expires_at"]
            ),
            lastRelayActivityAt: firstIntValue(
                in: payloadObject,
                keys: ["lastRelayActivityAt", "last_relay_activity_at"]
            ),
            relayHeartbeatStale: firstBoolValue(
                in: payloadObject,
                keys: ["relayHeartbeatStale", "relay_heartbeat_stale"]
            ) ?? false,
            canReconnect: firstBoolValue(in: payloadObject, keys: ["canReconnect", "can_reconnect"]) ?? false,
            bridgeVersion: bridgeInstalledVersion,
            bridgeLatestVersion: latestBridgePackageVersion
        )
    }

    func applyBridgeCapabilitySnapshot(from payloadObject: IncomingParamsObject) {
        bridgeInstalledVersion = firstStringValue(
            in: payloadObject,
            keys: ["bridgeVersion", "bridge_version", "bridgePackageVersion", "bridge_package_version"]
        )
        latestBridgePackageVersion = firstStringValue(
            in: payloadObject,
            keys: ["bridgeLatestVersion", "bridge_latest_version", "bridgePublishedVersion", "bridge_published_version"]
        )
        bridgeCodexVersion = firstStringValue(
            in: payloadObject,
            keys: ["codexVersion", "codex_version", "runtimeVersion", "runtime_version"]
        )

        let runtimeCapabilities = payloadObject["runtimeCapabilities"]?.objectValue
            ?? payloadObject["runtime_capabilities"]?.objectValue
            ?? payloadObject["capabilities"]?.objectValue?["runtimeCapabilities"]?.objectValue
            ?? payloadObject["capabilities"]?.objectValue?["runtime_capabilities"]?.objectValue

        if let planSupport = firstBoolValue(
            in: runtimeCapabilities,
            keys: ["planCollaborationMode", "plan_collaboration_mode"]
        ) {
            supportsTurnCollaborationMode = planSupport
        }

        if let serviceTierSupport = firstBoolValue(
            in: runtimeCapabilities,
            keys: ["serviceTier", "service_tier"]
        ) {
            supportsServiceTier = serviceTierSupport
        }

        if let threadForkSupport = firstBoolValue(
            in: runtimeCapabilities,
            keys: ["threadFork", "thread_fork"]
        ) {
            supportsThreadFork = threadForkSupport
        }

        if let voiceAuthSupport = firstBoolValue(
            in: runtimeCapabilities,
            keys: ["voiceResolveAuth", "voice_resolve_auth"]
        ) {
            supportsBridgeVoiceAuth = voiceAuthSupport
        }

        if let terminalSessionSupport = firstBoolValue(
            in: runtimeCapabilities,
            keys: ["terminalSessions", "terminal_sessions"]
        ) {
            supportsBridgeTerminalSessions = terminalSessionSupport
        }

        if let terminalRevealSupport = firstBoolValue(
            in: runtimeCapabilities,
            keys: ["terminalRevealOnMac", "terminal_reveal_on_mac"]
        ) {
            supportsBridgeTerminalRevealOnMac = terminalRevealSupport
        }
    }

    func shouldTreatAsUnsupportedBridgeProtocol(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError else {
            return false
        }

        switch serviceError {
        case .rpcError(let rpcError):
            if rpcError.code == -32601 {
                return true
            }

            let message = rpcError.message.lowercased()
            let mentionsUnsupportedMethod = message.contains("method not found")
                || message.contains("unknown method")
                || message.contains("not implemented")
                || message.contains("does not support")
            let mentionsBridgeMethod = message.contains("bridge/")
                || message.contains("bridge.")
                || message.contains("bridgeprotocol")
                || message.contains("bridge protocol")

            guard rpcError.code == -32600 || rpcError.code == -32602 || rpcError.code == -32000 else {
                return mentionsUnsupportedMethod && mentionsBridgeMethod
            }

            return mentionsUnsupportedMethod && mentionsBridgeMethod
        case .invalidResponse(let message):
            return message.localizedCaseInsensitiveContains("bridge/")
                || message.localizedCaseInsensitiveContains("bridge protocol")
        case .disconnected, .invalidInput(_), .invalidServerURL(_), .encodingFailed, .noPendingApproval:
            return false
        }
    }

    private func decodeBridgeEnvelope(from paramsObject: IncomingParamsObject?) -> CodexBridgeEnvelope? {
        guard let paramsObject else {
            return nil
        }

        return CodexBridgeEnvelope(
            event: firstStringValue(in: paramsObject, keys: ["event"]),
            rawMethod: firstStringValue(in: paramsObject, keys: ["rawMethod", "raw_method"]),
            rawParams: paramsObject["rawParams"] ?? paramsObject["raw_params"]
        )
    }

    private func decodeBridgeApprovalRequests(from payloadObject: IncomingParamsObject?) -> [CodexApprovalRequest] {
        let approvalItems = payloadObject?["approvals"]?.arrayValue
            ?? payloadObject?["items"]?.arrayValue
            ?? []
        return approvalItems.compactMap(decodeBridgeApprovalRequest(from:))
    }

    private func decodeBridgeApprovalRequest(from value: JSONValue) -> CodexApprovalRequest? {
        guard let objectValue = value.objectValue else {
            return nil
        }

        let requestId = firstStringValue(in: objectValue, keys: ["requestId", "requestID", "id"]) ?? ""
        guard !requestId.isEmpty else {
            return nil
        }

        let requestedAtMilliseconds = firstIntValue(in: objectValue, keys: ["requestedAt", "requested_at"])
        let requestedAt = requestedAtMilliseconds.map { milliseconds in
            Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
        }

        return CodexApprovalRequest(
            id: idKey(from: .string(requestId)),
            requestID: .string(requestId),
            method: firstStringValue(in: objectValue, keys: ["method"]) ?? "approval/request",
            command: firstStringValue(in: objectValue, keys: ["command"]),
            reason: firstStringValue(in: objectValue, keys: ["reason"]),
            threadId: firstStringValue(in: objectValue, keys: ["threadId", "thread_id"]),
            turnId: firstStringValue(in: objectValue, keys: ["turnId", "turn_id"]),
            requestedAt: requestedAt,
            params: objectValue["params"]
        )
    }

    private func decodeBridgeDiagnosticEnvelope(from payloadObject: IncomingParamsObject?) -> CodexBridgeDiagnosticEnvelope {
        let events = payloadObject?["events"]?.arrayValue?.compactMap(decodeBridgeDiagnosticEvent(from:)) ?? []
        return CodexBridgeDiagnosticEnvelope(events: events)
    }

    private func decodeBridgeDiagnosticEvent(from value: JSONValue) -> CodexBridgeDiagnosticEvent? {
        guard let objectValue = value.objectValue else {
            return nil
        }

        let id = firstStringValue(in: objectValue, keys: ["id"]) ?? UUID().uuidString
        let type = firstStringValue(in: objectValue, keys: ["type"]) ?? ""
        let level = firstStringValue(in: objectValue, keys: ["level"]) ?? "info"
        let message = firstStringValue(in: objectValue, keys: ["message"]) ?? ""
        let recordedAtMilliseconds = firstIntValue(in: objectValue, keys: ["recordedAt", "recorded_at"]) ?? 0
        guard !type.isEmpty, !message.isEmpty, recordedAtMilliseconds > 0 else {
            return nil
        }

        var metadata: [String: String] = [:]
        if let metadataObject = objectValue["metadata"]?.objectValue {
            for (key, rawValue) in metadataObject {
                if let stringValue = rawValue.stringValue, !stringValue.isEmpty {
                    metadata[key] = stringValue
                } else if let intValue = rawValue.intValue {
                    metadata[key] = String(intValue)
                } else if let boolValue = rawValue.boolValue {
                    metadata[key] = boolValue ? "true" : "false"
                }
            }
        }

        return CodexBridgeDiagnosticEvent(
            id: id,
            type: type,
            level: level,
            message: message,
            detail: firstStringValue(in: objectValue, keys: ["detail"]),
            recordedAt: Date(timeIntervalSince1970: TimeInterval(recordedAtMilliseconds) / 1000),
            metadata: metadata
        )
    }
}
