import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ScopeRef } from "@/lib/route";
import { basename } from "@/lib/tree";
import type { rpcContract, GitRepositoryStatus } from "../server.js";
import { isDirty, type FileTab } from "./use-file-tabs";
import { FileGlyph } from "./FileGlyph";
import { UnifiedDiff } from "./UnifiedDiff";

type PullInfo = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  mergeMethods: Array<"merge" | "squash" | "rebase">;
  url: string;
  baseRefName: string;
  headRefName: string;
  reviewDecision: string;
  mergeStateStatus: string;
  checks: Array<{ name: string; status: "success" | "failure" | "pending" | "neutral"; url: string }>;
};

type PullState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; pull: PullInfo | null };

interface SourceControlPanelProps {
  scope: ScopeRef | null;
  scopeLabel: string;
  dirtyTabs: readonly FileTab[];
  onBeforeGitAction: (paths: string[], run: () => Promise<void>) => void;
  onOpenDiff: (repoPath: string, path: string) => void;
  onRepositoriesChange: (repos: GitRepositoryStatus[]) => void;
  onSelectRepository: (repoPath: string) => void;
  onOpenAllChanges: () => void;
  refreshToken: number;
  className?: string;
}

export function SourceControlPanel({
  scope,
  scopeLabel,
  dirtyTabs,
  onBeforeGitAction,
  onOpenDiff,
  onRepositoriesChange,
  onSelectRepository,
  onOpenAllChanges,
  refreshToken,
  className,
}: SourceControlPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [repos, setRepos] = useState<GitRepositoryStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({});
  const [aiMessages, setAiMessages] = useState<Record<string, string>>({});
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const [pushTargets, setPushTargets] = useState<
    Record<string, { remote: string; branch: string }>
  >({});
  const [branchPrompt, setBranchPrompt] = useState<{
    repo: GitRepositoryStatus;
    branch: string;
  } | null>(null);
  const [pullForm, setPullForm] = useState<{
    repo: GitRepositoryStatus;
    base: string;
    title: string;
    body: string;
    draft: boolean;
    aiError: string | null;
  } | null>(null);
  const [mergePrompt, setMergePrompt] = useState<{
    repo: GitRepositoryStatus;
    pull: PullInfo;
    method: "merge" | "squash" | "rebase" | "";
  } | null>(null);
  const unsavedPaths = useMemo(
    () => new Set(dirtyTabs.filter(isDirty).map((tab) => tab.path)),
    [dirtyTabs],
  );
  const pullRequestsInFlight = useRef(new Set<string>());
  const scopeKey = scope === null ? "" : `${scope.kind}:${scope.id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = useCallback(async () => {
    const activeScope = scopeRef.current;
    if (activeScope === null) {
      setRepos([]);
      onRepositoriesChange([]);
      setLoadError(null);
      return [];
    }
    setLoading(true);
    setLoadError(null);
    try {
      const result = await rpc.call("sourceControl", { scope: activeScope });
      setRepos(result.repos);
      onRepositoriesChange(result.repos);
      setTruncated(result.truncated);
      setExpanded((current) => {
        if (current.size > 0 || result.repos.length === 0) return current;
        return new Set([result.repos[0]!.repoPath]);
      });
      return result.repos;
    } catch (error) {
      const message = messageOf(error, "Could not read Git status.");
      setLoadError(message);
      setRepos([]);
      onRepositoriesChange([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, [onRepositoriesChange, rpc, scopeKey]);

  useEffect(() => {
    pullRequestsInFlight.current.clear();
    setRepos([]);
    setPulls({});
    setExpanded(new Set());
    void load();
  }, [load, scopeKey, refreshToken]);

  const refresh = useCallback(async () => {
    pullRequestsInFlight.current.clear();
    setPulls({});
    return load();
  }, [load]);

  const loadPull = useCallback(
    async (repo: GitRepositoryStatus, force = false) => {
      const key = repo.repoPath;
      if (pullRequestsInFlight.current.has(key) && !force) return;
      pullRequestsInFlight.current.add(key);
      setPulls((current) => ({ ...current, [key]: { kind: "loading" } }));
      try {
        const activeScope = scopeRef.current;
        if (activeScope === null) return;
        const result = await rpc.call("pullRequest", { scope: activeScope, repoPath: key });
        setPulls((current) => ({
          ...current,
          [key]: result.ok
            ? { kind: "ready", pull: result.pull }
            : { kind: "error", message: result.message },
        }));
      } catch (error) {
        setPulls((current) => ({
          ...current,
          [key]: { kind: "error", message: messageOf(error, "GitHub status is unavailable.") },
        }));
      } finally {
        pullRequestsInFlight.current.delete(key);
      }
    },
    [rpc, scopeKey],
  );

  useEffect(() => {
    for (const repo of repos) {
      if (expanded.has(repo.repoPath) && hasGithubRemote(repo)) {
        void loadPull(repo);
      }
    }
  }, [expanded, loadPull, repos]);

  const setBusyKey = (key: string, value: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const withBusy = async (key: string, run: () => Promise<void>) => {
    setBusyKey(key, true);
    try {
      await run();
    } catch (error) {
      toast.error(messageOf(error, "Git action failed."));
    } finally {
      setBusyKey(key, false);
    }
  };

  const runWhenClean = (paths: readonly string[], run: () => Promise<void>) => {
    const dirty = [...new Set(paths)].filter((path) =>
      dirtyTabs.some((tab) => tab.path === path && isDirty(tab)),
    );
    if (dirty.length === 0) {
      void run();
      return;
    }
    onBeforeGitAction(dirty, run);
  };

  const stageFile = (repo: GitRepositoryStatus, path: string, stage: boolean) => {
    const activeScope = scopeRef.current;
    if (activeScope === null) return;
    const run = async () =>
      withBusy(`${repo.repoPath}:${path}`, async () => {
        await rpc.call("stageFile", { scope: activeScope, repoPath: repo.repoPath, path, stage });
        await refresh();
      });
    if (stage) runWhenClean([workspaceFilePath(repo.repoPath, path)], run);
    else void run();
  };

  const stageAll = (repo: GitRepositoryStatus) => {
    const activeScope = scopeRef.current;
    if (activeScope === null) return;
    runWhenClean(
      dirtyTabsForRepository(repo, repos, dirtyTabs),
      () =>
        withBusy(`${repo.repoPath}:stage-all`, async () => {
          await rpc.call("stageAll", { scope: activeScope, repoPath: repo.repoPath });
          await refresh();
        }),
    );
  };

  const generateCommitMessage = (repo: GitRepositoryStatus) => {
    const activeScope = scopeRef.current;
    if (activeScope === null) return;
    void withBusy(`${repo.repoPath}:ai-commit`, async () => {
      setAiMessages((current) => ({ ...current, [repo.repoPath]: "" }));
      const result = await rpc.call("suggestCommitMessage", {
        scope: activeScope,
        repoPath: repo.repoPath,
      });
      if (!result.ok) {
        setAiMessages((current) => ({ ...current, [repo.repoPath]: result.message }));
        return;
      }
      setCommitMessages((current) => ({ ...current, [repo.repoPath]: result.text }));
    });
  };

  const commit = (repo: GitRepositoryStatus) => {
    const activeScope = scopeRef.current;
    if (activeScope === null) return;
    const message = (commitMessages[repo.repoPath] ?? "").trim();
    if (message === "") return;
    const stagedPaths = repo.changes
      .filter((change) => change.staged)
      .map((change) => workspaceFilePath(repo.repoPath, change.path));
    runWhenClean(stagedPaths, () =>
      withBusy(`${repo.repoPath}:commit`, async () => {
        await rpc.call("commit", { scope: activeScope, repoPath: repo.repoPath, message });
        setCommitMessages((current) => ({ ...current, [repo.repoPath]: "" }));
        await refresh();
      }),
    );
  };

  const push = (repo: GitRepositoryStatus) => {
    const activeScope = scopeRef.current;
    if (activeScope === null) return;
    const target = pushTargets[repo.repoPath] ?? {
      remote: "",
      branch: "",
    };
    const remote = repo.upstream === null ? target.remote : null;
    const branch = repo.upstream === null ? target.branch : null;
    if ((remote === null) !== (branch === null) || remote === "" || branch === "") {
      toast.error("Choose a remote and branch to set the upstream.");
      return;
    }
    void withBusy(`${repo.repoPath}:push`, async () => {
      await rpc.call("push", { scope: activeScope, repoPath: repo.repoPath, remote, branch });
      await refresh();
      const latest = repos.find((candidate) => candidate.repoPath === repo.repoPath);
      if (latest !== undefined && hasGithubRemote(latest)) {
        await loadPull(latest, true);
      }
    });
  };

  const fillPullForm = async (
    repo: GitRepositoryStatus,
    info: { repo: string; defaultBranch: string },
    activeScope: ScopeRef,
  ) => {
    const suggestion = await rpc.call("suggestPullRequest", {
      scope: activeScope,
      repoPath: repo.repoPath,
    });
    setPullForm({
      repo,
      base: info.defaultBranch,
      title: suggestion.ok ? suggestion.title : "",
      body: suggestion.ok ? suggestion.body : "",
      draft: false,
      aiError: suggestion.ok ? null : suggestion.message,
    });
  };

  const startPullFlow = async (repo: GitRepositoryStatus) => {
    const activeScope = scopeRef.current;
    if (activeScope === null) return;
    await withBusy(`${repo.repoPath}:prepare-pr`, async () => {
      const response = await rpc.call("githubRepository", {
        scope: activeScope,
        repoPath: repo.repoPath,
      });
      if (!response.ok) throw new Error(response.message);
      if (repo.branch === response.defaultBranch) {
        setBranchPrompt({ repo, branch: suggestBranch(repo) });
        return;
      }
      if (repo.upstream === null || repo.ahead > 0) {
        toast.error("Push this branch before creating a pull request.");
        return;
      }
      await fillPullForm(repo, response, activeScope);
    });
  };

  const createPullRequest = () => {
    const activeScope = scopeRef.current;
    if (activeScope === null || pullForm === null) return;
    if (pullForm.title.trim() === "" || pullForm.body.trim() === "") {
      toast.error("Add a pull request title and description.");
      return;
    }
    void withBusy(`${pullForm.repo.repoPath}:create-pr`, async () => {
      const result = await rpc.call("createPullRequest", {
        scope: activeScope,
        repoPath: pullForm.repo.repoPath,
        title: pullForm.title,
        body: pullForm.body,
        base: pullForm.base,
        draft: pullForm.draft,
      });
      setPullForm(null);
      toast.success(`Pull request #${result.number} created.`, {
        action: {
          label: "Open",
          onClick: () => window.open(result.url, "_blank", "noopener,noreferrer"),
        },
      });
      await refresh();
      const current = repos.find((repo) => repo.repoPath === pullForm.repo.repoPath);
      if (current !== undefined) await loadPull(current, true);
    });
  };

  const mergePullRequest = () => {
    const activeScope = scopeRef.current;
    const prompt = mergePrompt;
    if (activeScope === null || prompt === null || prompt.method === "") return;
    const method = prompt.method;
    void withBusy(`${prompt.repo.repoPath}:merge-pr`, async () => {
      await rpc.call("mergePullRequest", {
        scope: activeScope,
        repoPath: prompt.repo.repoPath,
        number: prompt.pull.number,
        method,
      });
      setMergePrompt(null);
      toast.success(`Pull request #${prompt.pull.number} merged.`);
      await refresh();
      const current = repos.find((repo) => repo.repoPath === prompt.repo.repoPath);
      if (current !== undefined) await loadPull(current, true);
    });
  };

  const toggleRepo = (repo: GitRepositoryStatus) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(repo.repoPath)) next.delete(repo.repoPath);
      else next.add(repo.repoPath);
      return next;
    });
  };

  const hasAnyChanges = repos.some(
    (repo) => repo.changes.length > 0 || repo.branchChanges.length > 0,
  );

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-surface-recessed", className)}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Icon name="GitBranch" aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide">
          Source Control
        </h2>
        <button
          type="button"
          onClick={onOpenAllChanges}
          disabled={!hasAnyChanges}
          className="flex h-8 items-center gap-1.5 rounded px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40"
          title="Open all diffs"
        >
          <Icon name="FileDiff" aria-hidden className="size-4" />
          <span>All Changes</span>
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40"
          aria-label="Refresh Git status"
          title="Refresh Git status"
        >
          <Icon name="ArrowReloadHorizontal" aria-hidden className={cn("size-4", loading && "animate-spin")} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && repos.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground">Finding Git repositories…</p>
        ) : loadError !== null ? (
          <div className="space-y-2 px-4 py-5">
            <p className="text-sm text-destructive-text">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        ) : repos.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Icon name="GitBranch" aria-hidden className="mx-auto size-7 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No Git repositories found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {scope === null ? "Choose a workspace to inspect its repositories." : `No Git roots were found in ${scopeLabel}.`}
            </p>
          </div>
        ) : (
          <div>
            {truncated ? (
              <p className="border-b border-border px-3 py-2 text-xs text-warning-text">
                Some repositories could not be listed. Check excluded-directory settings and refresh.
              </p>
            ) : null}
            {repos.map((repo) => (
              <RepositoryGroup
                key={repo.repoPath}
                repo={repo}
                isExpanded={expanded.has(repo.repoPath)}
                isBusy={busy}
                commitMessage={commitMessages[repo.repoPath] ?? ""}
                aiMessage={aiMessages[repo.repoPath] ?? ""}
                pullState={pulls[repo.repoPath]}
                pushTarget={pushTargets[repo.repoPath] ?? {
                  remote: "",
                  branch: "",
                }}
                unsavedPaths={unsavedPaths}
                onToggle={() => toggleRepo(repo)}
                onSelectRepository={() => onSelectRepository(repo.repoPath)}
                onOpenDiff={(path) => onOpenDiff(repo.repoPath, path)}
                onStageFile={(path, stage) => stageFile(repo, path, stage)}
                onStageAll={() => stageAll(repo)}
                onCommitMessageChange={(value) =>
                  setCommitMessages((current) => ({ ...current, [repo.repoPath]: value }))
                }
                onGenerateCommit={() => generateCommitMessage(repo)}
                onCommit={() => commit(repo)}
                onPushTargetChange={(target) =>
                  setPushTargets((current) => ({ ...current, [repo.repoPath]: target }))
                }
                onPush={() => push(repo)}
                onPullRefresh={() => void loadPull(repo, true)}
                onCreatePull={() => void startPullFlow(repo)}
                onMergePull={(pull) => setMergePrompt({ repo, pull, method: "" })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        {repos.length} {repos.length === 1 ? "repository" : "repositories"} · {scopeLabel}
      </div>

      <Dialog open={branchPrompt !== null} onOpenChange={(open) => !open && setBranchPrompt(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create a feature branch?</DialogTitle>
            <DialogDescription>
              {branchPrompt?.repo.branch} is the default branch. Create {branchPrompt?.branch} and keep the current working changes on it. Then commit and push the branch before opening a pull request.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBranchPrompt(null)}>Cancel</Button>
            <Button
              disabled={branchPrompt === null || busy.has(`${branchPrompt.repo.repoPath}:create-branch`)}
              onClick={() => {
                const activeScope = scopeRef.current;
                if (branchPrompt === null || activeScope === null) return;
                const { repo, branch } = branchPrompt;
                setBranchPrompt(null);
                void withBusy(`${repo.repoPath}:create-branch`, async () => {
                  await rpc.call("createBranch", { scope: activeScope, repoPath: repo.repoPath, branch });
                  await refresh();
                  toast.success(`Created ${branch}. Commit and push it to continue the pull request flow.`);
                });
              }}
            >
              Create branch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pullForm !== null} onOpenChange={(open) => !open && setPullForm(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create pull request</DialogTitle>
            <DialogDescription>
              Review the AI draft and detected base branch before creating this GitHub pull request.
            </DialogDescription>
          </DialogHeader>
          {pullForm !== null ? (
            <div className="space-y-3">
              <label className="block space-y-1 text-xs font-medium">
                <span>Title</span>
                <Input
                  value={pullForm.title}
                  maxLength={256}
                  onChange={(event) => setPullForm({ ...pullForm, title: event.target.value })}
                  placeholder="Pull request title"
                />
              </label>
              <label className="block space-y-1 text-xs font-medium">
                <span>Description</span>
                <textarea
                  value={pullForm.body}
                  onChange={(event) => setPullForm({ ...pullForm, body: event.target.value })}
                  rows={9}
                  maxLength={50_000}
                  placeholder="Describe the branch changes"
                  className="min-h-40 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                />
              </label>
              <label className="block space-y-1 text-xs font-medium">
                <span>Base branch</span>
                <Input value={pullForm.base} onChange={(event) => setPullForm({ ...pullForm, base: event.target.value })} />
              </label>
              <label className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={pullForm.draft}
                  onChange={(event) => setPullForm({ ...pullForm, draft: event.target.checked })}
                  className="size-4 accent-current"
                />
                Create as draft
              </label>
              {pullForm.aiError !== null ? (
                <div className="flex items-center justify-between gap-3 rounded-md bg-surface-attention px-3 py-2 text-xs text-warning-text">
                  <span>{pullForm.aiError} You can enter the text manually.</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy.has(`${pullForm.repo.repoPath}:ai-pr`)}
                    onClick={() => void regeneratePullDraft()}
                  >
                    Retry AI
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPullForm(null)}>Cancel</Button>
            <Button
              disabled={pullForm === null || busy.has(`${pullForm.repo.repoPath}:create-pr`)}
              onClick={createPullRequest}
            >
              {pullForm?.draft ? "Create draft pull request" : "Create pull request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mergePrompt !== null} onOpenChange={(open) => !open && setMergePrompt(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Merge pull request?</DialogTitle>
            <DialogDescription>
              GitHub permissions and branch protection remain authoritative. Confirm the PR and choose one of the repository's enabled merge methods.
            </DialogDescription>
          </DialogHeader>
          {mergePrompt !== null ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">#{mergePrompt.pull.number} {mergePrompt.pull.title}</p>
              <a className="text-xs text-primary underline underline-offset-2" href={mergePrompt.pull.url} target="_blank" rel="noreferrer">Review pull request on GitHub</a>
              <select
                value={mergePrompt.method}
                onChange={(event) => setMergePrompt({ ...mergePrompt, method: event.target.value as typeof mergePrompt.method })}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                aria-label="Merge method"
              >
                <option value="">Choose merge method</option>
                {mergePrompt.pull.mergeMethods.map((method) => (
                  <option key={method} value={method}>{mergeMethodLabel(method)}</option>
                ))}
              </select>
              {mergePrompt.pull.mergeMethods.length === 0 ? (
                <p className="text-xs text-warning-text">This repository has no merge method enabled.</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Status: {mergePrompt.pull.state} · review: {mergePrompt.pull.reviewDecision || "none reported"} · mergeability: {mergePrompt.pull.mergeStateStatus || "unknown"}
              </p>
              {mergePrompt.pull.checks.length > 0 ? (
                <ul className="space-y-1 text-xs">
                  {mergePrompt.pull.checks.map((check) => (
                    <li key={`${check.name}-${check.url}`} className="flex items-center gap-2">
                      <CheckStatus status={check.status} />
                      <span>{check.name}</span>
                      <span className="ml-auto text-muted-foreground">{check.status}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergePrompt(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={mergePrompt === null || mergePrompt.method === "" || mergePrompt.pull.mergeMethods.length === 0 || busy.has(`${mergePrompt.repo.repoPath}:merge-pr`)}
              onClick={mergePullRequest}
            >
              Confirm merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  async function regeneratePullDraft() {
    const activeScope = scopeRef.current;
    if (activeScope === null || pullForm === null) return;
    const repoPath = pullForm.repo.repoPath;
    await withBusy(`${repoPath}:ai-pr`, async () => {
      const result = await rpc.call("suggestPullRequest", {
        scope: activeScope,
        repoPath,
      });
      if (!result.ok) {
        setPullForm((current) => current === null ? null : { ...current, aiError: result.message });
        return;
      }
      setPullForm((current) => current === null ? null : {
        ...current,
        title: result.title,
        body: result.body,
        aiError: null,
      });
    });
  }
}

function RepositoryGroup({
  repo,
  isExpanded,
  isBusy,
  commitMessage,
  aiMessage,
  pullState,
  pushTarget,
  unsavedPaths,
  onToggle,
  onSelectRepository,
  onOpenDiff,
  onStageFile,
  onStageAll,
  onCommitMessageChange,
  onGenerateCommit,
  onCommit,
  onPushTargetChange,
  onPush,
  onPullRefresh,
  onCreatePull,
  onMergePull,
}: {
  repo: GitRepositoryStatus;
  isExpanded: boolean;
  isBusy: ReadonlySet<string>;
  commitMessage: string;
  aiMessage: string;
  pullState: PullState | undefined;
  pushTarget: { remote: string; branch: string };
  unsavedPaths: ReadonlySet<string>;
  onToggle: () => void;
  onSelectRepository: () => void;
  onOpenDiff: (path: string) => void;
  onStageFile: (path: string, stage: boolean) => void;
  onStageAll: () => void;
  onCommitMessageChange: (value: string) => void;
  onGenerateCommit: () => void;
  onCommit: () => void;
  onPushTargetChange: (target: { remote: string; branch: string }) => void;
  onPush: () => void;
  onPullRefresh: () => void;
  onCreatePull: () => void;
  onMergePull: (pull: PullInfo) => void;
}) {
  const staged = repo.changes.filter((change) => change.staged);
  const unstaged = repo.changes.filter((change) => change.unstaged);
  const key = repo.repoPath;
  const pull = pullState?.kind === "ready" ? pullState.pull : null;
  const needsPush = repo.upstream === null || repo.ahead > 0;
  const pushBusy = isBusy.has(`${key}:push`);
  const commitBusy = isBusy.has(`${key}:commit`);
  const githubAvailable = hasGithubRemote(repo);

  return (
    <section className="border-b border-border">
      <button
        type="button"
        onClick={() => {
          onSelectRepository();
          onToggle();
        }}
        aria-expanded={isExpanded}
        className="flex min-h-12 w-full items-center gap-2 px-3 text-left hover:bg-state-hover"
      >
        <Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <Icon name="FolderGit" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{repo.repoPath === "" ? "Workspace root" : basename(repo.repoPath)}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {repo.changes.length + repo.branchChanges.length > 0
            ? `${repo.changes.length + repo.branchChanges.length}`
            : "clean"}
        </span>
      </button>

      {isExpanded ? (
        <div className="space-y-3 px-3 pb-3">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <Icon name="GitBranch" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{repo.branch ?? "Detached HEAD"}</span>
            {repo.upstream !== null ? <span className="truncate text-muted-foreground">{repo.upstream}</span> : <span className="text-warning-text">no upstream</span>}
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
              ↑{repo.ahead} ↓{repo.behind}
            </span>
          </div>

          <ChangeSection
            title="Staged Changes"
            changes={staged}
            emptyText="No staged changes"
            onOpenDiff={onOpenDiff}
            onAction={(path) => onStageFile(path, false)}
            actionLabel="Unstage file"
            actionIcon="ArrowTurnBackward"
            repoPath={repo.repoPath}
            unsavedPaths={unsavedPaths}
          />
          {unstaged.length > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 px-1">
                <h3 className="text-xs font-semibold">Changes</h3>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={isBusy.has(`${key}:stage-all`)} onClick={onStageAll}>
                  Stage All
                </Button>
              </div>
              <ChangeRows
                changes={unstaged}
                onOpenDiff={onOpenDiff}
                onAction={(path) => onStageFile(path, true)}
                actionLabel="Stage file"
                actionIcon="Plus"
                repoPath={repo.repoPath}
                unsavedPaths={unsavedPaths}
              />
            </div>
          ) : (
            <ChangeSection
              title="Changes"
              changes={[]}
              emptyText="No unstaged changes"
              onOpenDiff={onOpenDiff}
              onAction={(path) => onStageFile(path, true)}
              actionLabel="Stage file"
              actionIcon="Plus"
              repoPath={repo.repoPath}
              unsavedPaths={unsavedPaths}
            />
          )}

          {repo.branchChanges.length > 0 ? (
            <div className="space-y-1">
              <h3 className="px-1 text-xs font-semibold">Branch Changes · {repo.baseBranch ?? "base unknown"}</h3>
              <ul className="space-y-0.5">
                {repo.branchChanges.map((change) => (
                  <li key={`${change.path}-${change.status}`}>
                    <button type="button" onClick={() => onOpenDiff(change.path)} className="flex min-h-9 w-full items-center gap-2 rounded px-1.5 text-left text-xs hover:bg-state-hover">
                      <FileGlyph path={change.path} kind="file" />
                      <span className="min-w-0 flex-1 truncate">{change.path}</span>
                      <StatusMark status={change.status} />
                      <Icon name="FileDiff" aria-hidden className="size-3.5 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold">Commit</h3>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={staged.length === 0 || isBusy.has(`${key}:ai-commit`)} onClick={onGenerateCommit}>
                <Icon name="AiContentGenerator01" aria-hidden className="size-3.5" />
                Generate
              </Button>
            </div>
            <textarea
              value={commitMessage}
              onChange={(event) => onCommitMessageChange(event.target.value)}
              rows={2}
              maxLength={5_000}
              placeholder="Commit message"
              aria-label={`Commit message for ${repo.repoPath || "workspace root"}`}
              className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            />
            {aiMessage !== "" ? <p className="text-xs text-warning-text">AI suggestion unavailable: {aiMessage} Manual commit is still available.</p> : null}
            <Button className="w-full" size="sm" disabled={staged.length === 0 || commitMessage.trim() === "" || commitBusy} onClick={onCommit}>
              <Icon name="Check" aria-hidden className="size-4" />
              {commitBusy ? "Committing…" : `Commit Staged (${staged.length})`}
            </Button>
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <h3 className="text-xs font-semibold">Publish</h3>
            {repo.upstream === null ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  <span>Remote</span>
                  <select
                    value={pushTarget.remote}
                    onChange={(event) => onPushTargetChange({ ...pushTarget, remote: event.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    aria-label="Push remote"
                  >
                    <option value="">Choose remote</option>
                    {repo.remotes.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  <span>Branch</span>
                  <Input className="h-9" value={pushTarget.branch} placeholder="Branch name" onChange={(event) => onPushTargetChange({ ...pushTarget, branch: event.target.value })} aria-label="Push branch" />
                </label>
              </div>
            ) : null}
            <Button variant="outline" className="w-full" size="sm" disabled={!needsPush || repo.branch === null || pushBusy} onClick={onPush}>
              <Icon name="ArrowUp" aria-hidden className="size-4" />
              {pushBusy ? "Pushing…" : repo.upstream === null ? "Push and set upstream" : `Push ${repo.ahead} commit${repo.ahead === 1 ? "" : "s"}`}
            </Button>
          </div>

          {githubAvailable ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold">GitHub Pull Request</h3>
                <button type="button" onClick={onPullRefresh} aria-label="Refresh pull request status" title="Refresh pull request status" className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground">
                  <Icon name="ArrowReloadHorizontal" aria-hidden className="size-3.5" />
                </button>
              </div>
              {pullState?.kind === "loading" ? <p className="text-xs text-muted-foreground">Checking GitHub…</p> : null}
              {pullState?.kind === "error" ? <p className="text-xs text-warning-text">{pullState.message}</p> : null}
              {pull !== null ? (
                <PullRequestSummary pull={pull} onMerge={() => onMergePull(pull)} />
              ) : null}
              {pull === null ? (
                <Button variant="outline" size="sm" className="w-full" disabled={repo.branch === null || repo.branchChanges.length === 0} onClick={onCreatePull}>
                  <Icon name="GitPullRequest" aria-hidden className="size-4" />
                  Prepare pull request
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ChangeSection({
  title,
  changes,
  emptyText,
  onOpenDiff,
  onAction,
  actionLabel,
  actionIcon,
  repoPath,
  unsavedPaths,
}: {
  title: string;
  changes: GitRepositoryStatus["changes"];
  emptyText: string;
  onOpenDiff: (path: string) => void;
  onAction: (path: string) => void;
  actionLabel: string;
  actionIcon: "Plus" | "ArrowTurnBackward";
  repoPath: string;
  unsavedPaths: ReadonlySet<string>;
}) {
  return (
    <div className="space-y-1">
      <h3 className="px-1 text-xs font-semibold">{title}</h3>
      {changes.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ChangeRows changes={changes} onOpenDiff={onOpenDiff} onAction={onAction} actionLabel={actionLabel} actionIcon={actionIcon} repoPath={repoPath} unsavedPaths={unsavedPaths} />
      )}
    </div>
  );
}

function ChangeRows({
  changes,
  onOpenDiff,
  onAction,
  actionLabel,
  actionIcon,
  repoPath,
  unsavedPaths,
}: {
  changes: GitRepositoryStatus["changes"];
  onOpenDiff: (path: string) => void;
  onAction: (path: string) => void;
  actionLabel: string;
  actionIcon: "Plus" | "ArrowTurnBackward";
  repoPath: string;
  unsavedPaths: ReadonlySet<string>;
}) {
  return (
    <ul className="space-y-0.5">
      {changes.map((change) => (
        <li key={`${change.path}-${change.status}`} className="group flex min-h-10 items-center gap-1 rounded pr-1 hover:bg-state-hover">
          <button type="button" onClick={() => onOpenDiff(change.path)} className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left text-xs">
            <FileGlyph path={change.path} kind="file" />
            <span className="min-w-0 flex-1 truncate">{change.path}</span>
            {unsavedPaths.has(workspaceFilePath(repoPath, change.path)) ? (
              <span title="Unsaved editor draft" aria-label="Unsaved editor draft" className="size-1.5 shrink-0 rounded-full bg-warning-text" />
            ) : null}
            <StatusMark status={change.status} />
          </button>
          <button type="button" onClick={() => onAction(change.path)} aria-label={`${actionLabel} ${change.path}`} title={`${actionLabel} ${change.path}`} className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-active hover:text-foreground">
            <Icon name={actionIcon} aria-hidden className="size-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function PullRequestSummary({ pull, onMerge }: { pull: PullInfo; onMerge: () => void }) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-background p-2.5">
      <div className="flex items-start gap-2">
        <Icon name={pull.isDraft ? "GitPullRequestDraft" : "GitPullRequest"} aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <a className="block truncate text-xs font-medium text-primary underline-offset-2 hover:underline" href={pull.url} target="_blank" rel="noreferrer">#{pull.number} {pull.title}</a>
          <p className="mt-1 text-[11px] text-muted-foreground">{pull.headRefName} → {pull.baseRefName} · {pull.state}</p>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">Review: {pull.reviewDecision || "not requested"} · mergeability: {pull.mergeStateStatus || "unknown"}</p>
      {pull.checks.length > 0 ? (
        <ul className="space-y-1">
          {pull.checks.slice(0, 4).map((check) => (
            <li key={`${check.name}-${check.url}`} className="flex items-center gap-2 text-[11px]">
              <CheckStatus status={check.status} />
              <span className="min-w-0 flex-1 truncate">{check.name}</span>
              <span className="text-muted-foreground">{check.status}</span>
            </li>
          ))}
          {pull.checks.length > 4 ? <li className="text-[11px] text-muted-foreground">and {pull.checks.length - 4} more checks</li> : null}
        </ul>
      ) : null}
      <Button variant="outline" size="sm" className="w-full" disabled={pull.state !== "OPEN" || pull.isDraft} onClick={onMerge}>
        <Icon name="GitMerge" aria-hidden className="size-4" />
        Merge PR…
      </Button>
    </div>
  );
}

export function AllChangesView({
  scope,
  repos,
  onOpenDiff,
  onRefresh,
  onBeforeGitAction,
}: {
  scope: ScopeRef | null;
  repos: readonly GitRepositoryStatus[];
  onOpenDiff: (repoPath: string, path: string) => void;
  onRefresh: () => void;
  onBeforeGitAction: (repoPath: string, path: string, run: () => Promise<void>) => void;
}) {
  const [expandAll, setExpandAll] = useState(false);
  const changedRepos = repos.filter((repo) => repo.changes.length > 0 || repo.branchChanges.length > 0);
  const fileGroups = changedRepos.map((repo) => {
    const files = new Map<string, { status: string; categories: Set<string> }>();
    for (const change of repo.changes) {
      const current = files.get(change.path) ?? { status: change.status, categories: new Set<string>() };
      if (change.staged) current.categories.add("staged");
      if (change.unstaged) current.categories.add(change.untracked ? "untracked" : "working tree");
      files.set(change.path, current);
    }
    for (const change of repo.branchChanges) {
      const current = files.get(change.path) ?? { status: change.status, categories: new Set<string>() };
      current.categories.add("branch");
      files.set(change.path, current);
    }
    return { repo, files: [...files.entries()].map(([path, value]) => ({ path, ...value })) };
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Icon name="FileDiff" aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">All Changes</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">{fileGroups.reduce((count, group) => count + group.files.length, 0)} files across {changedRepos.length} repositories</span>
        {changedRepos.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            aria-label={expandAll ? "Collapse all diffs" : "Expand all diffs"}
            onClick={() => setExpandAll((current) => !current)}
          >
            {expandAll ? "Collapse all" : "Expand all"}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" className="h-8 px-2" onClick={onRefresh}>Refresh</Button>
      </div>
      {scope === null ? (
        <p className="p-5 text-sm text-muted-foreground">Choose a workspace to review its changes.</p>
      ) : changedRepos.length === 0 ? (
        <div className="m-auto max-w-sm px-6 text-center">
          <Icon name="Check" aria-hidden className="mx-auto size-7 text-diff-added" />
          <p className="mt-2 text-sm font-medium">No changes to review</p>
          <p className="mt-1 text-xs text-muted-foreground">Working tree and branch diffs will appear here.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {fileGroups.map(({ repo, files }) => (
            <section key={repo.repoPath} className="border-b border-border">
              <h3 className="sticky top-0 z-10 flex min-h-9 items-center gap-2 border-b border-border bg-surface-recessed px-3 text-xs font-semibold">
                <Icon name="FolderGit" aria-hidden className="size-3.5 text-muted-foreground" />
                {repo.repoPath || "Workspace root"}
                <span className="ml-auto font-normal text-muted-foreground">{repo.branch ?? "Detached HEAD"} · base {repo.baseBranch ?? "unknown"}</span>
              </h3>
              {files.map((file) => (
                <AllChangesFile
                  key={file.path}
                  scope={scope}
                  repo={repo}
                  file={file}
                  expandAll={expandAll}
                  onOpenDiff={() => onOpenDiff(repo.repoPath, file.path)}
                  onRefresh={onRefresh}
                  onBeforeGitAction={onBeforeGitAction}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AllChangesFile({
  scope,
  repo,
  file,
  expandAll,
  onOpenDiff,
  onRefresh,
  onBeforeGitAction,
}: {
  scope: ScopeRef;
  repo: GitRepositoryStatus;
  file: { path: string; status: string; categories: Set<string> };
  expandAll: boolean;
  onOpenDiff: () => void;
  onRefresh: () => void;
  onBeforeGitAction: (repoPath: string, path: string, run: () => Promise<void>) => void;
}) {
  const [open, setOpen] = useState(expandAll);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<{ staged: string; unstaged: string; branch: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rpc = useRpc<typeof rpcContract>();

  useEffect(() => setOpen(expandAll), [expandAll]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDiff(await rpc.call("gitDiff", { scope, repoPath: repo.repoPath, path: file.path }));
    } catch (cause) {
      setError(messageOf(cause, "Could not load this diff."));
    } finally {
      setLoading(false);
    }
  }, [file.path, repo.repoPath, rpc, scope]);

  useEffect(() => {
    if (open && diff === null && !loading && error === null) void load();
  }, [diff, error, load, loading, open]);

  const toggle = () => setOpen((current) => !current);

  return (
    <div className="border-b border-border/70">
      <div className="flex min-h-10 items-center gap-2 px-3">
        <button type="button" onClick={() => void toggle()} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-xs hover:text-foreground">
          <Icon name={open ? "ChevronDown" : "ChevronRight"} aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <FileGlyph path={file.path} kind="file" />
          <span className="truncate">{file.path}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            {[...file.categories].map((category) => <span key={category} className="rounded bg-state-active px-1.5 py-0.5">{category}</span>)}
          </span>
        </button>
        <StatusMark status={file.status} />
        <button type="button" onClick={onOpenDiff} className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground" aria-label={`Open ${file.path} diff in its own tab`} title="Open in a separate diff tab">
          <Icon name="NewTab" aria-hidden className="size-4" />
        </button>
      </div>
      {open ? (
        <div className="pb-2 pl-5">
          {loading ? <p className="px-3 py-3 text-xs text-muted-foreground">Loading diff…</p> : null}
          {error !== null ? <p className="px-3 py-3 text-xs text-destructive-text">{error}</p> : null}
          {diff !== null ? (
            <DiffSections
              scope={scope}
              repo={repo}
              path={file.path}
              diff={diff}
              onChanged={() => {
                setDiff(null);
                setError(null);
                onRefresh();
              }}
              onBeforeGitAction={(run) =>
                onBeforeGitAction(repo.repoPath, file.path, run)
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DiffEditor({
  scope,
  repoPath,
  repoLabel,
  path,
  onChanged,
  onBeforeGitAction,
}: {
  scope: ScopeRef | null;
  repoPath: string;
  repoLabel: string;
  path: string;
  onChanged: () => void;
  onBeforeGitAction: (repoPath: string, path: string, run: () => Promise<void>) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<{ staged: string; unstaged: string; branch: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const rpc = useRpc<typeof rpcContract>();

  const load = useCallback(async () => {
    if (scope === null) return;
    setLoading(true);
    setError(null);
    try {
      setDiff(await rpc.call("gitDiff", { scope, repoPath, path }));
    } catch (cause) {
      setError(messageOf(cause, "Could not load this diff."));
    } finally {
      setLoading(false);
    }
  }, [path, repoPath, rpc, scope]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Icon name="FileDiff" aria-hidden className="size-4 text-muted-foreground" />
        <span className="truncate text-xs text-muted-foreground">{repoLabel}</span>
        <span className="text-xs text-muted-foreground">/</span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{path}</span>
        <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => void load()}>Refresh</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? <p className="px-4 py-5 text-sm text-muted-foreground">Loading diff…</p> : null}
        {error !== null ? <p className="px-4 py-5 text-sm text-destructive-text">{error}</p> : null}
        {diff !== null && scope !== null ? (
          <DiffSections
            scope={scope}
            repo={{ repoPath }}
            path={path}
            diff={diff}
            onChanged={() => {
              setDiff(null);
              setRevision((current) => current + 1);
              onChanged();
            }}
            onBeforeGitAction={(run) => onBeforeGitAction(repoPath, path, run)}
          />
        ) : null}
      </div>
    </div>
  );
}

function DiffSections({
  scope,
  repo,
  path,
  diff,
  onChanged,
  onBeforeGitAction,
}: {
  scope: ScopeRef;
  repo: Pick<GitRepositoryStatus, "repoPath">;
  path: string;
  diff: { staged: string; unstaged: string; branch: string; truncated: boolean };
  onChanged: () => void;
  onBeforeGitAction: (run: () => Promise<void>) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const sections = [
    { kind: "branch" as const, label: "Branch Diff", patch: diff.branch },
    { kind: "staged" as const, label: "Staged Changes", patch: diff.staged },
    { kind: "unstaged" as const, label: "Working Tree Changes", patch: diff.unstaged },
  ].filter((section) => section.patch !== "");

  const stageHunk = async (kind: "staged" | "unstaged", index: number) => {
    onBeforeGitAction(async () => {
      setBusy(true);
      try {
        await rpc.call("stageHunks", {
          scope,
          repoPath: repo.repoPath,
          path,
          kind,
          hunkIndexes: [index],
        });
        onChanged();
      } catch (error) {
        toast.error(messageOf(error, "Could not stage this hunk."));
      } finally {
        setBusy(false);
      }
    });
  };

  if (sections.length === 0) {
    return <p className="px-4 py-5 text-sm text-muted-foreground">No current diff for this file.</p>;
  }

  return (
    <div className="space-y-3 py-2">
      {diff.truncated ? <p className="px-3 text-xs text-warning-text">Large diff clipped for display. Hunk selection applies to the current repository version.</p> : null}
      {sections.map((section) => (
        <section key={section.kind}>
          <h3 className="px-3 py-1 text-xs font-semibold text-muted-foreground">{section.label}</h3>
          <UnifiedDiff
            patch={section.patch}
            disabled={busy}
            action={section.kind === "branch" ? undefined : {
              label: section.kind === "unstaged" ? "Stage Hunk" : "Unstage Hunk",
              onStageHunk: (index) => void stageHunk(section.kind, index),
            }}
          />
        </section>
      ))}
    </div>
  );
}

function StatusMark({ status }: { status: string }) {
  const mark = status.includes("A") || status === "??" ? "A" : status.includes("D") ? "D" : status.includes("R") ? "R" : status.includes("U") ? "!" : "M";
  const tone = mark === "A" ? "text-diff-added" : mark === "D" ? "text-diff-removed" : "text-warning-text";
  return <span className={cn("shrink-0 font-mono text-[11px] font-semibold", tone)} aria-label={mark === "A" ? "Added" : mark === "D" ? "Deleted" : mark === "R" ? "Renamed" : "Modified"}>{mark}</span>;
}

function CheckStatus({ status }: { status: PullInfo["checks"][number]["status"] }) {
  const name = status === "success" || status === "neutral" ? "CircleCheck" : status === "failure" ? "CircleX" : "Circle";
  const tone = status === "success" || status === "neutral" ? "text-diff-added" : status === "failure" ? "text-destructive-text" : "text-warning-text";
  return <Icon name={name} aria-hidden className={cn("size-3.5 shrink-0", tone)} />;
}

function hasGithubRemote(repo: GitRepositoryStatus): boolean {
  return repo.remotes.some((remote) => /github\.com[:/]/u.test(remote.url));
}

function suggestBranch(repo: GitRepositoryStatus): string {
  const seed = repo.changes[0]?.path ?? repo.branchChanges[0]?.path ?? "work";
  const slug = seed
    .split(/[\\/]/u)
    .at(-1)!
    .replace(/\.[^.]+$/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 36) || "work";
  const date = new Date().toISOString().slice(2, 10).replace(/-/gu, "");
  return `work/${date}-${slug}`;
}

function mergeMethodLabel(method: "merge" | "squash" | "rebase"): string {
  return method === "merge" ? "Merge commit" : method === "squash" ? "Squash and merge" : "Rebase and merge";
}

function workspaceFilePath(repoPath: string, filePath: string): string {
  return repoPath === "" ? filePath : `${repoPath}/${filePath}`;
}

function dirtyTabsForRepository(
  repo: GitRepositoryStatus,
  repos: readonly GitRepositoryStatus[],
  tabs: readonly FileTab[],
): string[] {
  const nestedRoots = repos
    .filter((candidate) =>
      candidate.repoPath !== repo.repoPath &&
      (repo.repoPath === ""
        ? candidate.repoPath !== ""
        : candidate.repoPath.startsWith(`${repo.repoPath}/`)),
    )
    .map((candidate) => candidate.repoPath);
  return tabs
    .filter(isDirty)
    .filter((tab) => {
      const belongs = repo.repoPath === ""
        ? !nestedRoots.some((nested) => tab.path === nested || tab.path.startsWith(`${nested}/`))
        : tab.path.startsWith(`${repo.repoPath}/`);
      return belongs;
    })
    .map((tab) => tab.path);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}
