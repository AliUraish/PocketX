// FILE: PairWithCodeView.swift
// Purpose: Manual pairing screen for entering a relay URL and short-lived bridge code.
// Layer: View
// Exports: PairWithCodeView
// Depends on: SwiftUI, AppFont

import SwiftUI

struct PairWithCodeView: View {
    let initialRelayURL: String
    let onBack: (() -> Void)?
    let onSubmit: (_ pairingCode: String, _ relayURL: String, _ deviceName: String?) -> Void

    @State private var relayURL: String
    @State private var pairingCode = ""
    @State private var deviceName = ""
    @State private var validationMessage: String?

    init(
        initialRelayURL: String,
        onBack: (() -> Void)? = nil,
        onSubmit: @escaping (_ pairingCode: String, _ relayURL: String, _ deviceName: String?) -> Void
    ) {
        self.initialRelayURL = initialRelayURL
        self.onBack = onBack
        self.onSubmit = onSubmit
        _relayURL = State(initialValue: initialRelayURL)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    if let onBack {
                        Button(action: onBack) {
                            HStack(spacing: 6) {
                                Image(systemName: "chevron.left")
                                Text("Back")
                            }
                            .font(AppFont.body(weight: .semibold))
                            .foregroundStyle(.white)
                        }
                        .buttonStyle(.plain)
                    }

                    Spacer()
                }

                Spacer()

                VStack(alignment: .leading, spacing: 14) {
                    Text("Pair with Code")
                        .font(AppFont.system(size: 30, weight: .bold))
                        .foregroundStyle(.white)

                    Text("Enter the relay URL and the short-lived pairing code shown by `pocketex up` on your Mac.")
                        .font(AppFont.subheadline(weight: .regular))
                        .foregroundStyle(.white.opacity(0.62))
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(spacing: 14) {
                    labeledField(title: "Relay URL") {
                        TextField("wss://relay.example/relay", text: $relayURL)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .font(AppFont.mono(.footnote))
                    }

                    labeledField(title: "Pairing Code") {
                        TextField("ABCD-EFGH", text: $pairingCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .font(AppFont.mono(.title3))
                    }

                    labeledField(title: "Device Name (Optional)") {
                        TextField("My iPhone", text: $deviceName)
                            .textInputAutocapitalization(.words)
                            .autocorrectionDisabled()
                            .font(AppFont.body())
                    }
                }

                if let validationMessage, !validationMessage.isEmpty {
                    Text(validationMessage)
                        .font(AppFont.caption())
                        .foregroundStyle(.red.opacity(0.9))
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(action: submit) {
                    Text("Pair with Code")
                        .font(AppFont.body(weight: .semibold))
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity)
                        .frame(height: 56)
                        .background(.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)

                Text("The pairing code is single-use and expires after a few minutes. After pairing once, reconnect uses the trusted device session stored on your iPhone and Mac.")
                    .font(AppFont.caption())
                    .foregroundStyle(.white.opacity(0.45))
                    .fixedSize(horizontal: false, vertical: true)

                Spacer()
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 20)
        }
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private func labeledField<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.white.opacity(0.58))

            content()
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                )
        }
    }

    private func submit() {
        let normalizedRelayURL = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedPairingCode = pairingCode
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
            .replacingOccurrences(of: "[^A-Z0-9]", with: "", options: .regularExpression)
        let normalizedDeviceName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalizedRelayURL.isEmpty else {
            validationMessage = "Enter the relay URL for your Mac bridge."
            return
        }

        guard !normalizedPairingCode.isEmpty else {
            validationMessage = "Enter the pairing code shown on your Mac."
            return
        }

        validationMessage = nil
        onSubmit(
            normalizedPairingCode,
            normalizedRelayURL,
            normalizedDeviceName.isEmpty ? nil : normalizedDeviceName
        )
    }
}

#Preview {
    PairWithCodeView(initialRelayURL: "ws://100.100.100.10:9000/relay") { _, _, _ in }
}
