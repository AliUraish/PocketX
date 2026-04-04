// FILE: OnboardingView.swift
// Purpose: Split onboarding flow — swipeable pages with fixed bottom bar.
// Layer: View
// Exports: OnboardingView
// Depends on: SwiftUI, OnboardingWelcomePage, OnboardingFeaturesPage, OnboardingSetupOverviewPage

import SwiftUI

struct OnboardingView: View {
    let onContinue: () -> Void
    @State private var currentPage = 0
    @State private var isShowingCodexInstallReminder = false

    private let pageCount = 3
    private let codexInstallStepIndex = 2
    private let codexInstallCommand = "npm install -g @openai/codex@latest"

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                TabView(selection: $currentPage) {
                    OnboardingWelcomePage()
                        .tag(0)

                    OnboardingFeaturesPage()
                        .tag(1)

                    OnboardingSetupOverviewPage()
                        .tag(2)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))

                bottomBar
            }
        }
        .preferredColorScheme(.dark)
        .alert("Install Codex CLI First", isPresented: $isShowingCodexInstallReminder) {
            Button("Stay Here", role: .cancel) {}
            Button("Continue Anyway") {
                finishCurrentPage()
            }
        } message: {
            Text("Copy and paste \"\(codexInstallCommand)\" on your Mac before moving on. pocketex will not work until Codex CLI is installed and available in your PATH.")
        }
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        VStack(spacing: 20) {
            // Animated pill dots
            HStack(spacing: 8) {
                ForEach(0..<pageCount, id: \.self) { i in
                    Capsule()
                        .fill(i == currentPage ? DesignTokens.Colors.glassAccent : Color.white.opacity(0.18))
                        .frame(width: i == currentPage ? 24 : 8, height: 8)
                }
            }
            .animation(.spring(response: 0.35, dampingFraction: 0.8), value: currentPage)

            // CTA button
            Button(action: handleContinue) {
                HStack(spacing: 10) {
                    if currentPage == pageCount - 1 {
                        Image(systemName: "number.square")
                            .font(.system(size: 15, weight: .semibold))
                    }

                    Text(buttonTitle)
                        .font(AppFont.body(weight: .semibold))
                }
                .foregroundStyle(DesignTokens.Colors.glassAccent)
                .frame(maxWidth: .infinity)
                .frame(height: 56)
                .background(
                    Capsule(style: .continuous)
                        .fill(DesignTokens.Colors.glassAccent.opacity(0.16))
                )
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(DesignTokens.Colors.glassAccent.opacity(0.36), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .background(
            LinearGradient(
                colors: [.clear, .black.opacity(0.6), .black],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 50)
            .offset(y: -50),
            alignment: .top
        )
    }

    // MARK: - State

    private var buttonTitle: String {
        switch currentPage {
        case 0: return "Get Started"
        case 1: return "Continue"
        case pageCount - 1: return "Pair with Code"
        default: return "Continue"
        }
    }

    private func handleContinue() {
        // The CLI install step is a hard requirement, so warn before advancing.
        if currentPage == codexInstallStepIndex {
            isShowingCodexInstallReminder = true
            return
        }

        finishCurrentPage()
    }

    private func finishCurrentPage() {
        if currentPage < pageCount - 1 {
            advanceToNextPage()
        } else {
            onContinue()
        }
    }

    private func advanceToNextPage() {
        withAnimation(.easeInOut(duration: 0.3)) {
            currentPage += 1
        }
    }
}

// MARK: - Previews

#Preview("Full Flow") {
    OnboardingView {
        print("Continue tapped")
    }
}

#Preview("Light Override") {
    OnboardingView {
        print("Continue tapped")
    }
    .preferredColorScheme(.light)
}
