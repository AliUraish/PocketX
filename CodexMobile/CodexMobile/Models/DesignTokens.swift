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

        // Git sync status indicator
        static let gitSyncWarning = Color.orange
    }
}
