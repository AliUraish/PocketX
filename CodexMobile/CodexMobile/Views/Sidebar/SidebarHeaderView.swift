// FILE: SidebarHeaderView.swift
// Purpose: Displays the sidebar app identity header and top shortcuts.
// Layer: View Component
// Exports: SidebarHeaderView

import SwiftUI

struct SidebarHeaderView: View {
    let onOpenArchive: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 10) {
                Image("AppLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 26, height: 26)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                Text("pocketex")
                    .font(AppFont.title3(weight: .medium))
            }

            Spacer(minLength: 0)

            SidebarFloatingArchiveButton(action: onOpenArchive)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }
}

#Preview {
    SidebarHeaderView(onOpenArchive: {})
}
