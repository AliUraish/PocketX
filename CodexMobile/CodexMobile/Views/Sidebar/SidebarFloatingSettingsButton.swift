// FILE: SidebarFloatingSettingsButton.swift
// Purpose: Floating shortcut used to open sidebar settings.
// Layer: View Component
// Exports: SidebarFloatingArchiveButton, SidebarFloatingSettingsButton, SidebarMacConnectionStatusView

import SwiftUI

private struct SidebarFloatingIconButton: View {
    let systemName: String
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: {
            HapticFeedback.shared.triggerImpactFeedback()
            action()
        }) {
            Image(systemName: systemName)
                .font(AppFont.system(size: 17, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .adaptiveGlass(.regular, in: Circle())
        }
        .buttonStyle(.plain)
        .contentShape(Circle())
        .accessibilityLabel(accessibilityLabel)
    }
}

struct SidebarFloatingArchiveButton: View {
    let action: () -> Void

    var body: some View {
        SidebarFloatingIconButton(
            systemName: "archivebox.fill",
            accessibilityLabel: "Archived Chats",
            action: action
        )
    }
}

struct SidebarFloatingSettingsButton: View {
    let action: () -> Void

    var body: some View {
        SidebarFloatingIconButton(
            systemName: "gearshape.fill",
            accessibilityLabel: "Settings",
            action: action
        )
    }
}

struct SidebarMacConnectionStatusView: View {
    let name: String
    let systemName: String?
    let isConnected: Bool

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(statusTitle)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Text(name)
                .font(AppFont.subheadline())
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: 170, alignment: .trailing)
    }

    private var statusTitle: String {
        isConnected ? "Connected to Mac" : "Saved Mac"
    }
}
