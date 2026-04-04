// FILE: OpenSourceBadge.swift
// Purpose: Tappable open-source GitHub badge used across onboarding and about screens.
// Layer: View Component
// Exports: OpenSourceBadge

import SwiftUI

struct OpenSourceBadge: View {
    var style: BadgeStyle = .light

    enum BadgeStyle {
        case light
        case dark
        case accent
    }

    var body: some View {
        Group {
            if let repoURL = AppEnvironment.sourceRepositoryURL {
                Link(destination: repoURL) {
                    badgeLabel
                }
            } else {
                badgeLabel
            }
        }
        .accessibilityLabel("Open source on GitHub")
    }

    private var badgeLabel: some View {
        HStack(spacing: 6) {
            Image("github-mark-white")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 14, height: 14)

            Text("Open source")
                .font(AppFont.caption(weight: .medium))
        }
        .foregroundStyle(foregroundColor)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(
            Capsule(style: .continuous)
                .fill(backgroundFill)
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(borderColor, lineWidth: 1)
        )
    }

    private var foregroundColor: Color {
        switch style {
        case .light: .white.opacity(0.5)
        case .dark: .secondary
        case .accent: DesignTokens.Colors.glassAccent
        }
    }

    private var backgroundFill: Color {
        switch style {
        case .light: .white.opacity(0.06)
        case .dark: Color(.tertiarySystemFill).opacity(0.5)
        case .accent: DesignTokens.Colors.glassAccent.opacity(0.14)
        }
    }

    private var borderColor: Color {
        switch style {
        case .light: .white.opacity(0.08)
        case .dark: Color.primary.opacity(0.06)
        case .accent: DesignTokens.Colors.glassAccent.opacity(0.34)
        }
    }
}

#Preview("Light (dark bg)") {
    ZStack {
        Color.black.ignoresSafeArea()
        OpenSourceBadge(style: .light)
    }
    .preferredColorScheme(.dark)
}

#Preview("Dark (light bg)") {
    OpenSourceBadge(style: .dark)
        .padding()
}

#Preview("Accent") {
    ZStack {
        Color.black.ignoresSafeArea()
        OpenSourceBadge(style: .accent)
    }
    .preferredColorScheme(.dark)
}
