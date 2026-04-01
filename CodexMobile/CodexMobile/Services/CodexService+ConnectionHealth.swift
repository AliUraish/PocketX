// FILE: CodexService+ConnectionHealth.swift
// Purpose: Derives explicit layer-aware connection health from bridge snapshots plus local reconnect state.
// Layer: Service extension
// Exports: CodexBridgeHealthState, CodexBridgeHealthPresentation, CodexService connection health helpers
// Depends on: Foundation

import Foundation

enum CodexBridgeHealthState: String, Equatable, Sendable {
    case healthy
    case macOffline = "mac_offline"
    case bridgeDown = "bridge_down"
    case relayUnreachable = "relay_unreachable"
    case codexUnreachable = "codex_unreachable"
    case macSleepingOrUnresponsive = "mac_sleeping_or_unresponsive"
    case approvalPending = "approval_pending"
    case reconnecting
    case versionMismatch = "version_mismatch"
    case unknown

    var label: String {
        switch self {
        case .healthy:
            return "Healthy"
        case .macOffline:
            return "Mac Offline"
        case .bridgeDown:
            return "Bridge Down"
        case .relayUnreachable:
            return "Relay Unreachable"
        case .codexUnreachable:
            return "Codex Unreachable"
        case .macSleepingOrUnresponsive:
            return "Mac Sleeping"
        case .approvalPending:
            return "Approval Pending"
        case .reconnecting:
            return "Reconnecting"
        case .versionMismatch:
            return "Version Mismatch"
        case .unknown:
            return "Unknown"
        }
    }
}

struct CodexBridgeHealthPresentation: Equatable, Sendable {
    let state: CodexBridgeHealthState
    let summary: String
    let detail: String?
}

extension CodexService {
    var bridgeHealthState: CodexBridgeHealthState {
        if bridgeRequiresUpdateForConnectionHealth {
            return .versionMismatch
        }

        if let snapshotState = bridgeHealthSnapshot.flatMap({ CodexBridgeHealthState(rawValue: $0.status) }) {
            return snapshotState
        }

        if isConnecting || isReconnectRecoveryActive {
            return .reconnecting
        }

        if secureConnectionState == .liveSessionUnresolved, hasTrustedMacReconnectCandidate {
            return .macOffline
        }

        if let classifiedState = classifyBridgeHealthState(from: normalizedBridgeHealthErrorMessage) {
            return classifiedState
        }

        if isConnected {
            return .healthy
        }

        if hasReconnectCandidate {
            return .macOffline
        }

        return .unknown
    }

    var bridgeHealthPresentation: CodexBridgeHealthPresentation? {
        let state = bridgeHealthState
        if state == .unknown,
           !isConnected,
           !hasReconnectCandidate,
           bridgeHealthSnapshot == nil,
           normalizedBridgeHealthErrorMessage == nil {
            return nil
        }

        let snapshotError = bridgeHealthSnapshot?.lastError?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallbackError = normalizedBridgeHealthErrorMessage
        let detailSuffix = snapshotError?.isEmpty == false ? snapshotError : fallbackError

        switch state {
        case .healthy:
            return CodexBridgeHealthPresentation(
                state: .healthy,
                summary: "Your Mac bridge is healthy.",
                detail: (bridgeHealthSnapshot?.pendingApprovalCount ?? 0) > 0
                    ? approvalPendingDetailText(count: bridgeHealthSnapshot?.pendingApprovalCount ?? 0)
                    : nil
            )
        case .macOffline:
            return CodexBridgeHealthPresentation(
                state: .macOffline,
                summary: "Your Mac is offline.",
                detail: detailSuffix ?? "Wake the Mac and keep the rimcodex bridge running."
            )
        case .bridgeDown:
            return CodexBridgeHealthPresentation(
                state: .bridgeDown,
                summary: "The rimcodex bridge is down.",
                detail: detailSuffix ?? "Start the Mac bridge service, then reconnect."
            )
        case .relayUnreachable:
            return CodexBridgeHealthPresentation(
                state: .relayUnreachable,
                summary: "The relay is unreachable.",
                detail: detailSuffix ?? "Check the relay URL, network path, or Tailscale connectivity."
            )
        case .codexUnreachable:
            return CodexBridgeHealthPresentation(
                state: .codexUnreachable,
                summary: "Codex on your Mac is unavailable.",
                detail: detailSuffix ?? "The bridge is up, but codex app-server is not responding."
            )
        case .macSleepingOrUnresponsive:
            return CodexBridgeHealthPresentation(
                state: .macSleepingOrUnresponsive,
                summary: "Your Mac is sleeping or not responding.",
                detail: detailSuffix ?? "Wake the Mac or disable full system sleep, then reconnect."
            )
        case .approvalPending:
            return CodexBridgeHealthPresentation(
                state: .approvalPending,
                summary: "A run is waiting for approval.",
                detail: approvalPendingDetailText(count: bridgeHealthSnapshot?.pendingApprovalCount ?? 0)
            )
        case .reconnecting:
            return CodexBridgeHealthPresentation(
                state: .reconnecting,
                summary: "Trying to reconnect to your Mac.",
                detail: reconnectingDetailText
            )
        case .versionMismatch:
            return CodexBridgeHealthPresentation(
                state: .versionMismatch,
                summary: "This Mac bridge version is incompatible.",
                detail: bridgeUpdatePrompt?.message
                    ?? incompatibleBridgeVersionDetail(currentVersion: bridgeInstalledVersion)
            )
        case .unknown:
            return CodexBridgeHealthPresentation(
                state: .unknown,
                summary: "Bridge health is unavailable.",
                detail: detailSuffix
            )
        }
    }

    var bridgeHealthStatusLabel: String {
        bridgeHealthState.label
    }
}

private extension CodexService {
    var isReconnectRecoveryActive: Bool {
        if case .retrying = connectionRecoveryState {
            return true
        }
        return shouldAutoReconnectOnForeground
    }

    var bridgeRequiresUpdateForConnectionHealth: Bool {
        if secureConnectionState == .updateRequired {
            return true
        }

        guard let installedVersion = normalizedBridgeHealthPackageVersion(bridgeInstalledVersion) else {
            return false
        }

        return installedVersion.compare(CodexService.minimumSupportedBridgePackageVersion, options: .numeric) == .orderedAscending
    }

    var normalizedBridgeHealthErrorMessage: String? {
        let trimmed = lastErrorMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false) ? trimmed : nil
    }

    var reconnectingDetailText: String? {
        if case .retrying(_, let message) = connectionRecoveryState,
           !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return message
        }

        if let snapshot = bridgeHealthSnapshot,
           snapshot.relayHeartbeatStale {
            return "The bridge heartbeat stalled. rimcodex is trying to restore the relay path."
        }

        return normalizedBridgeHealthErrorMessage
    }

    func classifyBridgeHealthState(from message: String?) -> CodexBridgeHealthState? {
        guard let normalized = message?.lowercased(), !normalized.isEmpty else {
            return nil
        }

        if normalized.contains("update the npm package")
            || normalized.contains("too old for this version")
            || normalized.contains("requires rimcodex")
            || normalized.contains("update rimcodex on your mac") {
            return .versionMismatch
        }

        if normalized.contains("sleep")
            || normalized.contains("unresponsive")
            || normalized.contains("heartbeat stalled") {
            return .macSleepingOrUnresponsive
        }

        if normalized.contains("codex")
            && (normalized.contains("failed to start")
                || normalized.contains("not responding")
                || normalized.contains("endpoint")) {
            return .codexUnreachable
        }

        if normalized.contains("bridge")
            && (normalized.contains("down")
                || normalized.contains("not running")
                || normalized.contains("start the mac bridge")) {
            return .bridgeDown
        }

        if normalized.contains("relay")
            && (normalized.contains("cannot reach")
                || normalized.contains("could not reach")
                || normalized.contains("check the relay")
                || normalized.contains("resolve")
                || normalized.contains("timed out")) {
            return .relayUnreachable
        }

        if normalized.contains("trusted mac is offline")
            || normalized.contains("your trusted mac is offline")
            || normalized.contains("wake the mac") {
            return .macOffline
        }

        return nil
    }

    func approvalPendingDetailText(count: Int) -> String {
        if count <= 0 {
            return "Open the pending request on iPhone to continue the run."
        }
        if count == 1 {
            return "1 approval request is waiting on iPhone."
        }
        return "\(count) approval requests are waiting on iPhone."
    }

    func incompatibleBridgeVersionDetail(currentVersion: String?) -> String {
        guard let currentVersion = normalizedBridgeHealthPackageVersion(currentVersion) else {
            return "Update rimcodex on your Mac to \(CodexService.minimumSupportedBridgePackageVersion) or newer, then reconnect."
        }

        return "This Mac bridge is running rimcodex \(currentVersion), but this iPhone app requires \(CodexService.minimumSupportedBridgePackageVersion) or newer."
    }

    func normalizedBridgeHealthPackageVersion(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
