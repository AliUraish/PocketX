// FILE: SidebarView.swift
// Purpose: Orchestrates the sidebar experience with modular presentation components.
// Layer: View
// Exports: SidebarView
// Depends on: CodexService, Sidebar* components/helpers

import SwiftUI

struct SidebarView: View {
    @Environment(CodexService.self) private var codex

    @Binding var selectedThread: CodexThread?
    @Binding var showSettings: Bool
    @Binding var isSearchActive: Bool

    let onClose: () -> Void

    @State private var searchText = ""
    @State private var debouncedSearchText = ""
    @State private var isCreatingThread = false
    @State private var groupedThreads: [SidebarThreadGroup] = []
    @State private var isShowingNewChatProjectPicker = false
    @State private var projectGroupPendingArchive: SidebarThreadGroup? = nil
    @State private var threadPendingDeletion: CodexThread? = nil
    @State private var createThreadErrorMessage: String? = nil
    @State private var cachedDiffTotals: [String: TurnSessionDiffTotals] = [:]
    @State private var cachedRunBadges: [String: CodexThreadRunBadgeState] = [:]
    @State private var cachedTimingLabels: [String: String] = [:]
    @State private var lastDiffFingerprint: Int = 0
    @State private var lastBadgeFingerprint: Int = 0
    @State private var lastTimingFingerprint: Int = 0
    @State private var lastGroupingFingerprint: Int = 0
    @State private var lastGroupingQuery = ""

    var body: some View {
        let diffTotalsByThreadID = cachedDiffTotals

        VStack(alignment: .leading, spacing: 0) {
            SidebarHeaderView()

            SidebarSearchField(text: $searchText, isActive: $isSearchActive)
                .padding(.horizontal, DesignTokens.Spacing.lg)
                .padding(.top, 8)
                .padding(.bottom, 6)

            SidebarNewChatButton(
                isCreatingThread: isCreatingThread,
                isEnabled: canCreateThread,
                statusMessage: nil,
                action: handleNewChatButtonTap
            )
            .padding(.horizontal, DesignTokens.Spacing.lg)
            .padding(.top, 10)
            .padding(.bottom, 10)

            SidebarThreadListView(
                isFiltering: !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                isConnected: codex.isConnected,
                isCreatingThread: isCreatingThread,
                threads: codex.threads,
                groups: groupedThreads,
                selectedThread: selectedThread,
                bottomContentInset: 0,
                timingLabelProvider: { cachedTimingLabels[$0.id] },
                diffTotalsByThreadID: diffTotalsByThreadID,
                runBadgeStateByThreadID: cachedRunBadges,
                onSelectThread: selectThread,
                onCreateThreadInProjectGroup: { group in
                    handleNewChatTap(preferredProjectPath: group.projectPath)
                },
                onArchiveProjectGroup: { group in
                    projectGroupPendingArchive = group
                },
                onRenameThread: { thread, newName in
                    codex.renameThread(thread.id, name: newName)
                },
                onArchiveToggleThread: { thread in
                    if thread.syncState == .archivedLocal {
                        codex.unarchiveThread(thread.id)
                    } else {
                        codex.archiveThread(thread.id)
                        if selectedThread?.id == thread.id {
                            selectedThread = nil
                        }
                    }
                },
                onDeleteThread: { thread in
                    threadPendingDeletion = thread
                }
            )
            .refreshable {
                await refreshThreads()
            }

            HStack(spacing: 10) {
                SidebarFloatingSettingsButton(action: openSettings)
                Spacer(minLength: 0)
                if let trustedPairPresentation = codex.trustedPairPresentation {
                    SidebarMacConnectionStatusView(
                        name: trustedPairPresentation.name,
                        systemName: trustedPairPresentation.systemName,
                        isConnected: codex.isConnected
                    )
                }
            }
            .padding(.horizontal, DesignTokens.Spacing.lg)
            .padding(.top, 10)
        }
        .frame(maxHeight: .infinity)
        .background(DesignTokens.Colors.chatBackground)
        .task {
            rebuildGroupedThreadsIfNeeded(force: true)
            rebuildCachedSidebarStateIfNeeded(force: true)
            if codex.isConnected, codex.threads.isEmpty {
                await refreshThreads()
            }
        }
        .onChange(of: codex.threads) { _, _ in
            rebuildGroupedThreadsIfNeeded()
            rebuildCachedSidebarStateIfNeeded()
        }
        .task(id: searchText) {
            // Debounce: skip the rebuild until the user pauses typing for 200ms.
            guard !searchText.isEmpty else {
                debouncedSearchText = ""
                return
            }
            do {
                try await Task.sleep(nanoseconds: 200_000_000)
                debouncedSearchText = searchText
            } catch {}
        }
        .onChange(of: debouncedSearchText) { _, _ in
            rebuildGroupedThreadsIfNeeded()
        }
        .onChange(of: diffFingerprint) { _, _ in
            rebuildCachedDiffTotals()
        }
        .onChange(of: badgeFingerprint) { _, _ in
            rebuildCachedRunBadges()
        }
        .overlay {
            if SidebarThreadsLoadingPresentation.shouldShowOverlay(
                isLoadingThreads: codex.isLoadingThreads,
                threadCount: codex.threads.count
            ) {
                ProgressView()
                    .padding()
                    .background(DesignTokens.Colors.cardBackground, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(DesignTokens.Colors.cardBorder, lineWidth: 1))
            }
        }
        .sheet(isPresented: $isShowingNewChatProjectPicker) {
            SidebarNewChatProjectPickerSheet(
                choices: newChatProjectChoices,
                onSelectProject: { projectPath in
                    handleNewChatTap(preferredProjectPath: projectPath)
                },
                onSelectWithoutProject: {
                    handleNewChatTap(preferredProjectPath: nil)
                }
            )
        }
        .confirmationDialog(
            "Archive \"\(projectGroupPendingArchive?.label ?? "project")\"?",
            isPresented: Binding(
                get: { projectGroupPendingArchive != nil },
                set: { if !$0 { projectGroupPendingArchive = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Archive Project") {
                archivePendingProjectGroup()
            }
            Button("Cancel", role: .cancel) {
                projectGroupPendingArchive = nil
            }
        } message: {
            Text("All active chats in this project will be archived.")
        }
        .alert(
            "Delete \"\(threadPendingDeletion?.displayTitle ?? "conversation")\"?",
            isPresented: Binding(
                get: { threadPendingDeletion != nil },
                set: { if !$0 { threadPendingDeletion = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let thread = threadPendingDeletion {
                    if selectedThread?.id == thread.id {
                        selectedThread = nil
                    }
                    codex.deleteThread(thread.id)
                }
                threadPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) {
                threadPendingDeletion = nil
            }
        }
        .alert(
            "Action failed",
            isPresented: Binding(
                get: { createThreadErrorMessage != nil },
                set: { if !$0 { createThreadErrorMessage = nil } }
            ),
            actions: {
                Button("OK", role: .cancel) {
                    createThreadErrorMessage = nil
                }
            },
            message: {
                Text(createThreadErrorMessage ?? "Please try again.")
            }
        )
    }

    // MARK: - Actions

    private func refreshThreads() async {
        guard codex.isConnected else { return }
        do {
            try await codex.listThreads()
        } catch {
            // Error stored in CodexService.
        }
    }

    // Shows a native sheet so folder names and full paths stay readable on small screens.
    private func handleNewChatButtonTap() {
        if newChatProjectChoices.isEmpty {
            handleNewChatTap(preferredProjectPath: nil)
            return
        }

        isShowingNewChatProjectPicker = true
    }

    private func handleNewChatTap(preferredProjectPath: String?) {
        Task { @MainActor in
            createThreadErrorMessage = nil
            isCreatingThread = true
            defer { isCreatingThread = false }

            do {
                let thread = try await codex.startThreadIfReady(preferredProjectPath: preferredProjectPath)
                selectedThread = thread
                onClose()
            } catch {
                let message = error.localizedDescription
                codex.lastErrorMessage = message
                createThreadErrorMessage = message.isEmpty ? "Unable to create a chat right now." : message
            }
        }
    }

    private func selectThread(_ thread: CodexThread) {
        searchText = ""
        debouncedSearchText = ""
        codex.activeThreadId = thread.id
        codex.markThreadAsViewed(thread.id)
        selectedThread = thread
        onClose()
    }

    private func openSettings() {
        searchText = ""
        debouncedSearchText = ""
        showSettings = true
        onClose()
    }

    // Archives every live chat in the selected project group and clears the current selection if needed.
    private func archivePendingProjectGroup() {
        guard let group = projectGroupPendingArchive else { return }

        let threadIDs = SidebarThreadGrouping.liveThreadIDsForProjectGroup(group, in: codex.threads)
        let selectedThreadWasArchived = selectedThread.map { selected in
            threadIDs.contains(selected.id)
        } ?? false

        _ = codex.archiveThreadGroup(threadIDs: threadIDs)

        if selectedThreadWasArchived {
            selectedThread = codex.threads.first(where: { thread in
                thread.syncState == .live && !threadIDs.contains(thread.id)
            })
        }

        projectGroupPendingArchive = nil
    }

    // Rebuilds sidebar sections only when search or grouping-relevant thread metadata changed.
    private func rebuildGroupedThreadsIfNeeded(force: Bool = false) {
        let query = debouncedSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let fingerprint = groupingFingerprint(query: query)
        guard force || fingerprint != lastGroupingFingerprint || query != lastGroupingQuery else { return }
        lastGroupingFingerprint = fingerprint
        lastGroupingQuery = query
        let source: [CodexThread]
        if query.isEmpty {
            source = codex.threads
        } else {
            source = codex.threads.filter {
                $0.displayTitle.localizedCaseInsensitiveContains(query)
                || $0.projectDisplayName.localizedCaseInsensitiveContains(query)
            }
        }
        groupedThreads = SidebarThreadGrouping.makeGroups(from: source)
    }

    // Cheap fingerprint: hashes thread IDs + message revisions (O(n) integer work, no message access).
    private var diffFingerprint: Int {
        var hasher = Hasher()
        for thread in codex.threads {
            hasher.combine(thread.id)
            hasher.combine(codex.messageRevision(for: thread.id))
        }
        return hasher.finalize()
    }

    // Cheap fingerprint for run badge state — changes when running/ready/failed sets change.
    private var badgeFingerprint: Int {
        var hasher = Hasher()
        for thread in codex.threads {
            hasher.combine(thread.id)
            if let badge = codex.threadRunBadgeState(for: thread.id) {
                hasher.combine(badge)
            }
        }
        return hasher.finalize()
    }

    private func rebuildCachedSidebarStateIfNeeded(force: Bool = false) {
        rebuildCachedDiffTotals(force: force)
        rebuildCachedRunBadges(force: force)
        rebuildCachedTimingLabels(force: force)
    }

    private func rebuildCachedDiffTotals(force: Bool = false) {
        let fp = diffFingerprint
        guard force || fp != lastDiffFingerprint else { return }
        lastDiffFingerprint = fp

        var byThreadID: [String: TurnSessionDiffTotals] = [:]
        for thread in codex.threads {
            let messages = codex.messages(for: thread.id)
            if let totals = TurnSessionDiffSummaryCalculator.totals(
                from: messages,
                scope: .unpushedSession
            ) {
                byThreadID[thread.id] = totals
            }
        }
        cachedDiffTotals = byThreadID
    }

    private func rebuildCachedRunBadges(force: Bool = false) {
        let fp = badgeFingerprint
        guard force || fp != lastBadgeFingerprint else { return }
        lastBadgeFingerprint = fp

        var byThreadID: [String: CodexThreadRunBadgeState] = [:]
        for thread in codex.threads {
            if let state = codex.threadRunBadgeState(for: thread.id) {
                byThreadID[thread.id] = state
            }
        }
        cachedRunBadges = byThreadID
    }


    private func rebuildCachedTimingLabels(force: Bool = false) {
        let fp = timingFingerprint
        guard force || fp != lastTimingFingerprint else { return }
        lastTimingFingerprint = fp

        let now = Date()
        cachedTimingLabels = Dictionary(
            uniqueKeysWithValues: codex.threads.compactMap { thread in
                guard let label = SidebarRelativeTimeFormatter.compactLabel(for: thread, now: now) else {
                    return nil
                }
                return (thread.id, label)
            }
        )
    }

private func groupingFingerprint(query: String) -> Int {
    var hasher = Hasher()
    hasher.combine(query)
    for thread in codex.threads {
        hasher.combine(thread.id)
        hasher.combine(thread.displayTitle)
        hasher.combine(thread.projectDisplayName)
        hasher.combine(thread.syncState)
        hasher.combine(thread.parentThreadId)
        hasher.combine(thread.isSubagent)
        hasher.combine(thread.updatedAt?.timeIntervalSince1970 ?? 0)
        hasher.combine(thread.createdAt?.timeIntervalSince1970 ?? 0)
    }
    return hasher.finalize()
}

private var timingFingerprint: Int {
    var hasher = Hasher()
    for thread in codex.threads {
        hasher.combine(thread.id)
        hasher.combine(thread.updatedAt?.timeIntervalSince1970 ?? 0)
        hasher.combine(thread.createdAt?.timeIntervalSince1970 ?? 0)
    }
    return hasher.finalize()
}


    // Keeps the chooser in sync with the same project buckets shown in the sidebar.
    private var newChatProjectChoices: [SidebarProjectChoice] {
        SidebarThreadGrouping.makeProjectChoices(from: codex.threads)
    }

    private var canCreateThread: Bool {
        codex.isConnected && codex.isInitialized
    }
}

enum SidebarThreadsLoadingPresentation {
    // Keeps pull-to-refresh from stacking a second spinner over an already populated sidebar.
    static func shouldShowOverlay(isLoadingThreads: Bool, threadCount: Int) -> Bool {
        isLoadingThreads && threadCount == 0
    }
}

private struct SidebarNewChatProjectPickerSheet: View {
    let choices: [SidebarProjectChoice]
    let onSelectProject: (String) -> Void
    let onSelectWithoutProject: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Choose a project for this chat.")
                        .font(AppFont.body())
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }

                Section("Local") {
                    ForEach(choices) { choice in
                        Button {
                            dismiss()
                            onSelectProject(choice.projectPath)
                        } label: {
                            HStack(spacing: 12) {
                                if choice.iconSystemName == "arrow.triangle.branch" {
                                    CodexWorktreeIcon(pointSize: 16, weight: .medium)
                                        .foregroundStyle(.secondary)
                                } else {
                                    Image(systemName: choice.iconSystemName)
                                        .font(AppFont.body(weight: .medium))
                                        .foregroundStyle(.secondary)
                                }

                                Text(choice.label)
                                    .font(AppFont.body(weight: .semibold))
                                    .foregroundStyle(.primary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }

                Section {
                    Button {
                        dismiss()
                        onSelectWithoutProject()
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: "cloud")
                                .font(AppFont.body(weight: .medium))
                                .foregroundStyle(.secondary)

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Cloud")
                                    .font(AppFont.body(weight: .semibold))
                                    .foregroundStyle(.primary)
                                    .frame(maxWidth: .infinity, alignment: .leading)

                                Text("Start a chat without a local working directory.")
                                    .font(AppFont.body())
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }

                Section {
                    // Explains the existing scoping rule at the exact moment the user chooses it.
                    Text("Chats started in a project stay scoped to that working directory. If you pick Cloud, the chat is global.")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("Start new chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents(choices.count > 4 ? [.medium, .large] : [.medium])
    }
}
