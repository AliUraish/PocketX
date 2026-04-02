// FILE: SidebarThreadRunBadgeView.swift
// Purpose: Renders the compact run-state indicator dot for sidebar conversation rows.
// Layer: View Component
// Exports: SidebarThreadRunBadgeView
// Depends on: SwiftUI, CodexThreadRunBadgeState

import SwiftUI

struct SidebarThreadRunBadgeView: View {
    let state: CodexThreadRunBadgeState

    var body: some View {
        Circle()
            .fill(state.color)
            .frame(width: 10, height: 10)
            .overlay(
                Circle()
                    .stroke(Color(.systemBackground), lineWidth: 1)
            )
            .accessibilityHidden(true)
    }
}

private extension CodexThreadRunBadgeState {
    var color: Color {
        switch self {
        case .running:
            return DesignTokens.Colors.runBadgeRunning
        case .ready:
            return DesignTokens.Colors.runBadgeReady
        case .failed:
            return DesignTokens.Colors.runBadgeFailed
        }
    }
}
