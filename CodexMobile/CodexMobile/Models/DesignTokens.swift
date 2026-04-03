// FILE: DesignTokens.swift
// Purpose: Shared spacing, corner radius, and semantic color constants used across views.
// Layer: Model
// Exports: DesignTokens

import SwiftUI

enum DesignTokens {
    enum Spacing {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 20
    }

    enum CornerRadius {
        /// Thread row selection highlight and search pill.
        static let row: CGFloat = 14
        /// Generic card and overlay surfaces.
        static let card: CGFloat = 12
    }

    enum Colors {
        // Run badge states
        static let runBadgeRunning = Color.blue
        static let runBadgeReady = Color.green
        static let runBadgeFailed = Color.red

        // Sidebar row
        static let rowSelected = Color(.tertiarySystemFill).opacity(0.8)
        static let archiveBadgeForeground = Color.orange
        static let archiveBadgeBackground = Color.orange.opacity(0.12)

        // Icon button (e.g. project group "+" button)
        static let iconButtonBackground = Color.primary.opacity(0.08)

        // Git sync status indicator
        static let gitSyncWarning = Color.orange

        // Theme surface colors
        static let chatBackground = Color(red: 13.0 / 255.0, green: 10.0 / 255.0, blue: 20.0 / 255.0)
        static let cardBackground = Color(red: 19.0 / 255.0, green: 16.0 / 255.0, blue: 28.0 / 255.0)
        static let inputBackground = Color(red: 26.0 / 255.0, green: 21.0 / 255.0, blue: 40.0 / 255.0)
        static let cardBorder = Color(red: 35.0 / 255.0, green: 29.0 / 255.0, blue: 53.0 / 255.0)
        static let selectedBorder = Color(red: 61.0 / 255.0, green: 46.0 / 255.0, blue: 107.0 / 255.0)
        static let glassAccent = Color(red: 1.0, green: 107.0 / 255.0, blue: 26.0 / 255.0)
    }
}
