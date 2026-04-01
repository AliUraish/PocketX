// FILE: AppEnvironment.swift
// Purpose: Centralizes local runtime endpoint and public app config lookups.
// Layer: Service
// Exports: AppEnvironment
// Depends on: Foundation

import Foundation

enum AppEnvironment {
    private static let defaultRelayURLInfoPlistKeys = ["RIMCODEX_DEFAULT_RELAY_URL", "PHODEX_DEFAULT_RELAY_URL"]
    private static let sourceRepositoryURLInfoPlistKey = "RIMCODEX_SOURCE_REPOSITORY_URL"
    private static let privacyPolicyURLInfoPlistKey = "RIMCODEX_PRIVACY_POLICY_URL"
    private static let termsOfUseURLInfoPlistKey = "RIMCODEX_TERMS_OF_USE_URL"
    private static let revenueCatPublicAPIKeyInfoPlistKey = "REVENUECAT_PUBLIC_API_KEY"
    private static let revenueCatEntitlementNameInfoPlistKey = "REVENUECAT_ENTITLEMENT_NAME"
    private static let revenueCatDefaultOfferingIDInfoPlistKey = "REVENUECAT_DEFAULT_OFFERING_ID"

    // Open-source builds should provide an explicit relay instead of silently
    // pointing at a hosted service the user does not control.
    static let defaultRelayURLString = ""

    static var relayBaseURL: String {
        for key in defaultRelayURLInfoPlistKeys {
            if let infoURL = resolvedString(forInfoPlistKey: key) {
                return infoURL
            }
        }
        return defaultRelayURLString
    }

    // Reads the public RevenueCat key shipped with the client build.
    static var revenueCatPublicAPIKey: String? {
        resolvedString(forInfoPlistKey: revenueCatPublicAPIKeyInfoPlistKey)
    }

    // Keeps entitlement naming centralized so purchase checks stay consistent.
    static var revenueCatEntitlementName: String {
        resolvedString(forInfoPlistKey: revenueCatEntitlementNameInfoPlistKey) ?? "Pro"
    }

    // Mirrors the RevenueCat default offering ID used in the dashboard.
    static var revenueCatDefaultOfferingID: String {
        resolvedString(forInfoPlistKey: revenueCatDefaultOfferingIDInfoPlistKey) ?? "default"
    }

    static var sourceRepositoryURL: URL? {
        guard let rawValue = resolvedString(forInfoPlistKey: sourceRepositoryURLInfoPlistKey) else {
            return nil
        }
        return URL(string: rawValue)
    }

    static var privacyPolicyURL: URL? {
        guard let rawValue = resolvedString(forInfoPlistKey: privacyPolicyURLInfoPlistKey) else {
            return nil
        }
        return URL(string: rawValue)
    }

    static var termsOfUseURL: URL? {
        guard let rawValue = resolvedString(forInfoPlistKey: termsOfUseURLInfoPlistKey) else {
            return nil
        }
        return URL(string: rawValue)
    }
}

private extension AppEnvironment {
    static func resolvedString(forInfoPlistKey key: String) -> String? {
        guard let rawValue = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }

        let trimmedValue = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedValue.isEmpty else {
            return nil
        }

        if trimmedValue.hasPrefix("$("), trimmedValue.hasSuffix(")") {
            return nil
        }

        return trimmedValue
    }
}
