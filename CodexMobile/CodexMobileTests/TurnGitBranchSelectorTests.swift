// FILE: TurnGitBranchSelectorTests.swift
// Purpose: Verifies new branch creation names normalize toward the pocketex/ prefix without double-prefixing.
// Layer: Unit Test
// Exports: TurnGitBranchSelectorTests
// Depends on: XCTest, CodexMobile

import XCTest
@testable import CodexMobile

final class TurnGitBranchSelectorTests: XCTestCase {
    func testNormalizesCreatedBranchNamesTowardPocketexPrefix() {
        XCTAssertEqual(pocketexNormalizedCreatedBranchName("foo"), "pocketex/foo")
        XCTAssertEqual(pocketexNormalizedCreatedBranchName("pocketex/foo"), "pocketex/foo")
        XCTAssertEqual(pocketexNormalizedCreatedBranchName("  foo  "), "pocketex/foo")
    }

    func testNormalizesEmptyBranchNamesToEmptyString() {
        XCTAssertEqual(pocketexNormalizedCreatedBranchName("   "), "")
    }

    func testCurrentBranchSelectionDisablesCheckedOutElsewhereRowsWhenWorktreePathIsMissing() {
        XCTAssertTrue(
            pocketexCurrentBranchSelectionIsDisabled(
                branch: "pocketex/feature-a",
                currentBranch: "main",
                gitBranchesCheckedOutElsewhere: ["pocketex/feature-a"],
                gitWorktreePathsByBranch: [:],
                allowsSelectingCurrentBranch: true
            )
        )
    }

    func testCurrentBranchSelectionKeepsCheckedOutElsewhereRowsEnabledWhenWorktreePathExists() {
        XCTAssertFalse(
            pocketexCurrentBranchSelectionIsDisabled(
                branch: "pocketex/feature-a",
                currentBranch: "main",
                gitBranchesCheckedOutElsewhere: ["pocketex/feature-a"],
                gitWorktreePathsByBranch: ["pocketex/feature-a": "/tmp/pocketex-feature-a"],
                allowsSelectingCurrentBranch: true
            )
        )
    }
}
