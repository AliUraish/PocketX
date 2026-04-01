// FILE: CodexService+Approvals.swift
// Purpose: Centralizes approval queue state so reconnect hydration and per-thread resolution stay consistent.
// Layer: Service
// Exports: CodexService approval queue helpers
// Depends on: Foundation

import Foundation

extension CodexService {
    var pendingApproval: CodexApprovalRequest? {
        pendingApprovalRequests.first
    }

    func pendingApproval(forThreadId threadId: String?) -> CodexApprovalRequest? {
        guard let normalizedThreadID = normalizedInterruptIdentifier(threadId) else {
            return pendingApproval
        }

        return pendingApprovalRequests.first { request in
            guard let requestThreadID = normalizedInterruptIdentifier(request.threadId) else {
                return true
            }
            return requestThreadID == normalizedThreadID
        }
    }

    func clearPendingApprovals() {
        pendingApprovalRequests.removeAll()
    }

    func replacePendingApprovals(_ requests: [CodexApprovalRequest]) {
        pendingApprovalRequests = deduplicatedApprovalRequests(from: requests)
    }

    func enqueuePendingApproval(_ request: CodexApprovalRequest) {
        var nextRequests = pendingApprovalRequests.filter { $0.id != request.id }
        nextRequests.append(request)
        pendingApprovalRequests = deduplicatedApprovalRequests(from: nextRequests)
    }

    func removePendingApproval(requestID: JSONValue) {
        removePendingApproval(idKey: idKey(from: requestID))
    }

    func removePendingApproval(idKey: String) {
        pendingApprovalRequests.removeAll { $0.id == idKey }
    }

    private func deduplicatedApprovalRequests(from requests: [CodexApprovalRequest]) -> [CodexApprovalRequest] {
        var dedupedByID: [String: CodexApprovalRequest] = [:]
        for request in requests {
            dedupedByID[request.id] = request
        }

        return dedupedByID.values.sorted { left, right in
            let leftTimestamp = left.requestedAt?.timeIntervalSince1970 ?? 0
            let rightTimestamp = right.requestedAt?.timeIntervalSince1970 ?? 0
            if leftTimestamp == rightTimestamp {
                return left.id < right.id
            }
            return leftTimestamp < rightTimestamp
        }
    }
}
