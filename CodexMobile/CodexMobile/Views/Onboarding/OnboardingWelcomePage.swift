// FILE: OnboardingWelcomePage.swift
// Purpose: Welcome splash — first page of the onboarding flow with hero image.
// Layer: View
// Exports: OnboardingWelcomePage
// Depends on: SwiftUI, AppFont

import SwiftUI

struct OnboardingWelcomePage: View {
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                // Base black
                Color.black.ignoresSafeArea()

                // Hero image — full screen, fills top to bottom
                Image("three")
                    .resizable()
                    .scaledToFill()
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
                    .brightness(-0.36)
                    .saturation(0.9)
                    .ignoresSafeArea()

                // Gradient: clear at top → black at bottom so content is readable
                LinearGradient(
                    stops: [
                        .init(color: .black.opacity(0.15), location: 0.0),
                        .init(color: .clear, location: 0.18),
                        .init(color: .black.opacity(0.55), location: 0.55),
                        .init(color: .black.opacity(0.88), location: 0.72),
                        .init(color: .black, location: 0.85),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()

                // Content overlay
                VStack(spacing: 0) {
                    HStack {
                        Spacer()
                        OpenSourceBadge(style: .accent)
                        Spacer()
                    }
                    .padding(.top, 8)
                    .padding(.horizontal, 28)

                    Spacer()

                    VStack(spacing: 24) {
                        Image("AppLogo")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 76, height: 76)
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 20, style: .continuous)
                                    .stroke(
                                        LinearGradient(
                                            colors: [.white.opacity(0.25), .white.opacity(0.04)],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        ),
                                        lineWidth: 1
                                    )
                            )

                        VStack(spacing: 10) {
                            Text("PocketX")
                                .font(AppFont.system(size: 34, weight: .bold))
                                .foregroundStyle(DesignTokens.Colors.glassAccent)
                                .multilineTextAlignment(.center)

                            Text("Control Codex from your iPhone.")
                                .font(AppFont.subheadline(weight: .regular))
                                .foregroundStyle(DesignTokens.Colors.glassAccent.opacity(0.6))
                                .multilineTextAlignment(.center)
                        }

                        HStack(spacing: 6) {
                            Image(systemName: "lock.shield.fill")
                                .font(.system(size: 11, weight: .medium))
                            Text("End-to-end encrypted")
                                .font(AppFont.caption(weight: .medium))
                        }
                        .foregroundStyle(DesignTokens.Colors.glassAccent.opacity(0.5))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 28)
                    .padding(.bottom, 28)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}

#Preview {
    ZStack {
        Color.black.ignoresSafeArea()
        OnboardingWelcomePage()
    }
    .preferredColorScheme(.dark)
}
