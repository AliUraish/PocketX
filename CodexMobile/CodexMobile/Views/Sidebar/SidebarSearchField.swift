// FILE: SidebarSearchField.swift
// Purpose: Compact search pill for filtering sidebar threads.
// Layer: View Component
// Exports: SidebarSearchField

import SwiftUI

struct SidebarSearchField: View {
    // Mirrors the selected sidebar row so the search field feels like part of the same list system.
    private let selectedRowCornerRadius: CGFloat = DesignTokens.CornerRadius.row

    @Binding var text: String
    @Binding var isActive: Bool
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(AppFont.subheadline())
                    .foregroundStyle(.secondary)

                TextField("Search conversations", text: $text)
                    .font(AppFont.subheadline())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($isFocused)

                if !text.isEmpty {
                    Button {
                        text = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(AppFont.subheadline())
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.leading, 10)
            .padding(.trailing, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                DesignTokens.Colors.inputBackground,
                in: RoundedRectangle(cornerRadius: selectedRowCornerRadius, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: selectedRowCornerRadius, style: .continuous)
                    .stroke(DesignTokens.Colors.cardBorder, lineWidth: 1)
            )

            if isFocused {
                Button("Cancel") {
                    text = ""
                    isFocused = false
                }
                .font(AppFont.subheadline())
                .foregroundStyle(.primary)
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isFocused)
        .onChange(of: isFocused) { _, newValue in
            isActive = newValue
        }
    }
}
