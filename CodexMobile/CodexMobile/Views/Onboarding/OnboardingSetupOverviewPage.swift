// FILE: OnboardingSetupOverviewPage.swift
// Purpose: Single-screen onboarding setup overview with all pairing steps in a two-column card grid.
// Layer: View
// Exports: OnboardingSetupOverviewPage
// Depends on: SwiftUI, AppFont

import SwiftUI

private struct OnboardingSetupStep: Identifiable {
    let id: Int
    let number: Int
    let icon: String
    let title: String
    let description: String
    let command: String?
    let tint: Color
}

private let onboardingSetupSteps: [OnboardingSetupStep] = [
    .init(
        id: 0,
        number: 1,
        icon: "terminal",
        title: "Install Codex CLI",
        description: "Add the coding agent to your Mac first.",
        command: "npm install -g @openai/codex@latest",
        tint: .cyan
    ),
    .init(
        id: 1,
        number: 2,
        icon: "link",
        title: "Install the Bridge",
        description: "Install pocketex so your iPhone can connect securely.",
        command: "npm install -g pocketex@latest",
        tint: .green
    ),
    .init(
        id: 2,
        number: 3,
        icon: "play.fill",
        title: "Run on Your Mac",
        description: "Start the bridge and generate a short-lived pairing code.",
        command: "pocketex up",
        tint: .orange
    ),
    .init(
        id: 3,
        number: 4,
        icon: "number.square",
        title: "Enter the Code",
        description: "Continue to the next screen and enter the code on your iPhone.",
        command: nil,
        tint: .pink
    ),
]

struct OnboardingSetupOverviewPage: View {
    private let columns = [
        GridItem(.flexible(), spacing: 12, alignment: .top),
        GridItem(.flexible(), spacing: 12, alignment: .top),
    ]

    var body: some View {
        ZStack {
            RadialGradient(
                colors: [Color(.plan).opacity(0.08), .clear],
                center: .top,
                startRadius: 20,
                endRadius: 420
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer(minLength: 0)

                VStack(spacing: 24) {
                    VStack(spacing: 10) {
                        Text("Set Up in 4 Steps")
                            .font(AppFont.system(size: 28, weight: .bold))
                            .foregroundStyle(DesignTokens.Colors.glassAccent)

                        Text("Everything you need is here on one screen. Run the Mac commands in order, then continue to pair.")
                            .font(AppFont.subheadline())
                            .foregroundStyle(DesignTokens.Colors.glassAccent.opacity(0.55))
                            .multilineTextAlignment(.center)
                            .lineSpacing(3)
                    }

                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(onboardingSetupSteps) { step in
                            stepCard(step)
                        }
                    }
                }
                .padding(.horizontal, 20)

                Spacer(minLength: 0)
            }
            .padding(.vertical, 24)
        }
    }

    @ViewBuilder
    private func stepCard(_ step: OnboardingSetupStep) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                Text("\(step.number)")
                    .font(AppFont.caption2(weight: .bold))
                    .foregroundStyle(.black)
                    .frame(width: 24, height: 24)
                    .background(step.tint, in: Circle())

                Spacer(minLength: 8)

                Image(systemName: step.icon)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(step.tint)
                    .frame(width: 30, height: 30)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(step.tint.opacity(0.16))
                    )
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(step.title)
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(DesignTokens.Colors.glassAccent)
                    .fixedSize(horizontal: false, vertical: true)

                Text(step.description)
                    .font(AppFont.caption())
                    .foregroundStyle(DesignTokens.Colors.glassAccent.opacity(0.55))
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)

            if let command = step.command {
                Text(command)
                    .font(AppFont.mono(.caption2))
                    .foregroundStyle(DesignTokens.Colors.glassAccent.opacity(0.82))
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.white.opacity(0.05))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(Color.white.opacity(0.07), lineWidth: 1)
                    )
            }
        }
        .frame(maxWidth: .infinity, minHeight: 188, alignment: .topLeading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.white.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }
}

#Preview {
    ZStack {
        Color.black.ignoresSafeArea()
        OnboardingSetupOverviewPage()
    }
    .preferredColorScheme(.dark)
}
