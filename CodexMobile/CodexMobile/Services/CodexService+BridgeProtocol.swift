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
            return
        }

        await refreshBridgeProtocolState()
        await refreshBridgeManagedState(allowAvailableBridgeUpdatePrompt: allowAvailableBridgeUpdatePrompt)
    }

    func refreshBridgeProtocolAvailability() async {
        guard isConnected else {
            bridgeProtocolAvailability = .unknown
            bridgeHealthSnapshot = nil
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

            bridgeInstalledVersion = firstStringValue(
                in: payloadObject,
                keys: ["bridgeVersion", "bridge_version", "bridgePackageVersion", "bridge_package_version"]
            )
            latestBridgePackageVersion = firstStringValue(
                in: payloadObject,
                keys: ["bridgeLatestVersion", "bridge_latest_version", "bridgePublishedVersion", "bridge_published_version"]
            )
        } catch {
            if shouldTreatAsUnsupportedBridgeProtocol(error) {
                bridgeProtocolAvailability = .unsupported
                bridgeHealthSnapshot = nil
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
            applyBridgeHealthSnapshot(from: payloadObject)
        } catch {
            if shouldTreatAsUnsupportedBridgeProtocol(error) {
                bridgeProtocolAvailability = .unsupported
            }
            bridgeHealthSnapshot = nil
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
}
