# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

BB users who browse and edit files in the project checkout or worktree associated with a thread.

## Product Purpose

Files Editor provides a workspace-aware file explorer and editor inside BB. Success means users can find, inspect, edit, save, and review project files without leaving the workspace context that BB selected for them.

## Positioning

The editor follows BB's selected project or worktree and uses BB's current theme and configured services, so file work stays connected to the agent workspace.

## Operating Context

Users work across local or connected hosts, project checkouts, and thread worktrees. A project checkout can contain multiple Git roots, including submodules and linked worktrees. Phone users need full-screen Explorer, Editor, and Source Control destinations.

## Capabilities and Constraints

- Browse, search, preview, edit, and save workspace files; file edits use conflict-aware saves.
- Restore each workspace's Explorer expansion and scroll location, including when the last editor tab closes.
- Source Control groups Git status by repository in the selected checkout or worktree. It includes staged, unstaged, untracked, and branch changes; whole-file staging works on all devices and hunk staging is a desktop control.
- Commits use the staged set. Push is a separate action and uses an upstream when available.
- Commit messages, pull request titles, and descriptions are entered manually.
- GitHub pull request actions run GitHub CLI (`gh`) on the host that owns each workspace; that host must have `gh` installed and authenticated. Other Git hosts retain file diffs and Git actions without pull request controls.
- Pull request creation requires a review form. Merging requires a confirmation and an explicit repository-allowed merge method; GitHub permissions and branch protection remain authoritative.
- Local Git actions run on the host that owns the selected workspace. Connected-host behavior depends on the host's Git installation and credentials.

## Brand Commitments

Use VS Code's workbench structure and familiar file-icon language while inheriting BB's active theme.

## Evidence on Hand

The existing plugin provides the file explorer, workspace selection, editor tabs, syntax-highlighted reading and editing, and conflict-aware save flow. No customer testimonials, external product claims, or benchmark evidence are established.

## Product Principles

- Keep file work attached to the selected project or worktree.
- Make repository state and consequential Git actions visible before they run.
- Keep drafts editable and require an explicit action to commit, push, create, or merge.
- Preserve useful navigation state when users change views or devices.
- Fit the workbench to BB's active theme and make the same core tasks usable on phones.
