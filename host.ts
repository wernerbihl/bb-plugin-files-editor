import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  experimental_sanitizeInheritedChildProcessEnv as sanitizeEnv,
  experimental_spawnPortableOutputProcess as spawnOutput,
} from "@get-bb/plugin-sdk/host";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { gitHostContract } from "./git-host-contract.js";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 160 * 1024;
const MAX_DISCOVERED_DIRECTORIES = 30_000;
const MAX_DISCOVERED_REPOSITORIES = 300;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: "git" | "gh",
  args: string[],
  cwd: string,
  signal: AbortSignal,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? MAX_GIT_OUTPUT_BYTES;
  const env = {
    ...sanitizeEnv({ env: process.env }),
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GCM_INTERACTIVE: "Never",
    ...(command === "gh"
      ? { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" }
      : {}),
  };

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error(`${command} operation cancelled`));
      return;
    }

    const child = spawnOutput({ command, args, cwd, env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };

    const abort = () => {
      failure = new Error(`${command} operation cancelled`);
      child.kill("SIGTERM");
    };

    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        failure = new Error(`${command} output exceeded its size limit`);
        child.kill("SIGTERM");
        return;
      }
      target.push(buffer);
    };

    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      failure = new Error(`${command} operation timed out after ${timeoutMs}ms`);
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      cleanup();
      if (
        command === "gh" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        reject(
          new Error(
            "GitHub CLI (gh) is not installed on this workspace host. Install gh and authenticate it with `gh auth login`.",
          ),
        );
        return;
      }
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (failure !== null) {
        reject(failure);
        return;
      }
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<GitResult> {
  return runCommand("git", args, cwd, signal, options);
}

function runGh(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<GitResult> {
  return runCommand("gh", args, cwd, signal, options);
}

async function gitText(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  options?: { timeoutMs?: number; maxBytes?: number },
): Promise<string> {
  const result = await runGit(args, cwd, signal, options);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`,
    );
  }
  return result.stdout.trimEnd();
}

async function ghText(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  options?: { timeoutMs?: number; maxBytes?: number },
): Promise<string> {
  const result = await runGh(args, cwd, signal, options);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `gh ${args[0]} failed`,
    );
  }
  return result.stdout.trimEnd();
}

const githubRepositoryViewSchema = z
  .object({
    defaultBranchRef: z.object({ name: z.string() }).nullable(),
    mergeCommitAllowed: z.boolean(),
    squashMergeAllowed: z.boolean(),
    rebaseMergeAllowed: z.boolean(),
    url: z.string().url(),
  })
  .passthrough();

const githubPullViewSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    isDraft: z.boolean(),
    url: z.string().url(),
    baseRefName: z.string(),
    headRefName: z.string(),
    reviewDecision: z.string().nullable().optional(),
    mergeStateStatus: z.string().nullable().optional(),
    statusCheckRollup: z.array(z.unknown()).default([]),
  })
  .passthrough();

type MergeMethod = "merge" | "squash" | "rebase";
type CheckStatus = "success" | "failure" | "pending" | "neutral";

async function githubRepositoryInfo(
  repository: string,
  repo: string,
  signal: AbortSignal,
) {
  const result = await ghText(
    [
      "repo",
      "view",
      repo,
      "--json",
      "defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,url",
    ],
    repository,
    signal,
  );
  const data = githubRepositoryViewSchema.parse(JSON.parse(result));
  const defaultBranch = data.defaultBranchRef?.name;
  if (defaultBranch === undefined || defaultBranch.length === 0) {
    throw new Error("GitHub did not report a default branch for this repository.");
  }
  const mergeMethods: MergeMethod[] = [];
  if (data.mergeCommitAllowed) mergeMethods.push("merge");
  if (data.squashMergeAllowed) mergeMethods.push("squash");
  if (data.rebaseMergeAllowed) mergeMethods.push("rebase");
  return { defaultBranch, mergeMethods, url: data.url };
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string") ?? "";
}

function checkStatus(value: Record<string, unknown>): CheckStatus {
  const conclusion = stringValue(value.conclusion).toUpperCase();
  const state = stringValue(value.state).toUpperCase();
  const status = stringValue(value.status).toUpperCase();
  if (conclusion === "SUCCESS" || state === "SUCCESS") return "success";
  if (
    [
      "FAILURE",
      "TIMED_OUT",
      "CANCELLED",
      "ERROR",
      "ACTION_REQUIRED",
      "STALE",
      "STARTUP_FAILURE",
    ].includes(conclusion) || ["FAILURE", "ERROR"].includes(state)
  ) {
    return "failure";
  }
  if (conclusion === "NEUTRAL" || conclusion === "SKIPPED" || state === "NEUTRAL") {
    return "neutral";
  }
  if (
    ["PENDING", "IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING"].includes(
      status,
    ) || ["PENDING", "EXPECTED"].includes(state)
  ) {
    return "pending";
  }
  return "neutral";
}

function pullChecks(values: unknown[]): Array<{
  name: string;
  status: CheckStatus;
  url: string;
}> {
  return values.map((value) => {
    const item = objectValue(value);
    return {
      name: stringValue(item.name, item.context, item.workflowName) || "Check",
      status: checkStatus(item),
      url: stringValue(item.detailsUrl, item.targetUrl),
    };
  });
}

async function githubPullRequest(
  repository: string,
  repo: string,
  signal: AbortSignal,
  number?: number,
) {
  const repoInfo = await githubRepositoryInfo(repository, repo, signal);
  const args = ["pr", "view"];
  if (number !== undefined) args.push(String(number));
  args.push(
    "--repo",
    repo,
    "--json",
    "number,title,state,isDraft,url,baseRefName,headRefName,reviewDecision,mergeStateStatus,statusCheckRollup",
  );
  const result = await runGh(args, repository, signal);
  if (
    number === undefined &&
    result.code !== 0 &&
    /no pull requests found/iu.test(`${result.stderr}\n${result.stdout}`)
  ) {
    return { pull: null };
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "gh pr view failed");
  }
  const data = githubPullViewSchema.parse(JSON.parse(result.stdout));
  return {
    pull: {
      number: data.number,
      title: data.title,
      state: data.state,
      isDraft: data.isDraft,
      mergeMethods: repoInfo.mergeMethods,
      url: data.url,
      baseRefName: data.baseRefName,
      headRefName: data.headRefName,
      reviewDecision: data.reviewDecision ?? "",
      mergeStateStatus: data.mergeStateStatus ?? "",
      checks: pullChecks(data.statusCheckRollup),
    },
  };
}

function resolveRepository(root: string, repoPath: string): string {
  const absoluteRoot = path.resolve(root);
  if (
    path.isAbsolute(repoPath) ||
    path.win32.isAbsolute(repoPath) ||
    repoPath.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("Repository path must stay inside the selected workspace");
  }
  const repository = path.resolve(absoluteRoot, repoPath || ".");
  const relative = path.relative(absoluteRoot, repository);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Repository path must stay inside the selected workspace");
  }
  return repository;
}

function resolveFile(repository: string, filePath: string): string {
  if (
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    filePath.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("File path must stay inside its repository");
  }
  const absolutePath = path.resolve(repository, filePath);
  const relative = path.relative(repository, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("File path must stay inside its repository");
  }
  return absolutePath;
}

async function assertRepository(
  root: string,
  repoPath: string,
  signal: AbortSignal,
): Promise<string> {
  const repository = resolveRepository(root, repoPath);
  const topLevel = await gitText(
    ["rev-parse", "--show-toplevel"],
    repository,
    signal,
  );
  const samePath =
    process.platform === "win32"
      ? path.resolve(topLevel).toLowerCase() === repository.toLowerCase()
      : path.resolve(topLevel) === repository;
  if (!samePath) throw new Error("The selected folder is not a Git root");
  return repository;
}

function parseChangedFiles(text: string) {
  const entries = text.split("\0").filter((entry) => entry.length > 0);
  const files: Array<{
    path: string;
    previousPath: string | null;
    status: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
  }> = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    let filePath = entry.slice(3);
    let previousPath: string | null = null;
    if (status.includes("R") || status.includes("C")) {
      previousPath = entries[index + 1] ?? null;
      index += 1;
    }
    const untracked = status === "??";
    files.push({
      path: filePath,
      previousPath,
      status,
      staged: !untracked && status[0] !== " " && status[0] !== ".",
      unstaged: untracked || (status[1] !== " " && status[1] !== "."),
      untracked,
    });
  }
  return files;
}

function parseBranchFiles(text: string) {
  const entries = text.split("\0").filter((entry) => entry.length > 0);
  const files: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < entries.length; ) {
    const status = entries[index++]!;
    let filePath = entries[index++] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      filePath = entries[index++] ?? filePath;
    }
    files.push({ path: filePath, status });
  }
  return files;
}

function clipped(text: string, maxBytes = MAX_DIFF_BYTES) {
  if (Buffer.byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  const buffer = Buffer.from(text, "utf8");
  return {
    text: `${buffer.subarray(0, maxBytes).toString("utf8")}\n… diff truncated`,
    truncated: true,
  };
}

async function inspectRepository(
  root: string,
  repoPath: string,
  signal: AbortSignal,
) {
  const repository = await assertRepository(root, repoPath, signal);
  const branch = await gitText(
    ["branch", "--show-current"],
    repository,
    signal,
  ).catch(() => "");
  const upstream = await gitText(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    repository,
    signal,
  ).catch(() => "");
  const remotesText = await gitText(["remote"], repository, signal).catch(
    () => "",
  );
  const remotes: Array<{ name: string; url: string }> = [];
  for (const name of remotesText.split("\n").filter(Boolean)) {
    const url = await gitText(
      ["remote", "get-url", name],
      repository,
      signal,
    ).catch(() => "");
    if (url !== "") remotes.push({ name, url });
  }

  const preferredRemote = remotes.find((remote) => remote.name === "origin") ?? remotes[0];
  let defaultBranch: string | null = null;
  if (preferredRemote !== undefined) {
    const symbolicHead = await gitText(
      ["symbolic-ref", "--quiet", "--short", `refs/remotes/${preferredRemote.name}/HEAD`],
      repository,
      signal,
    ).catch(() => "");
    if (symbolicHead.startsWith(`${preferredRemote.name}/`)) {
      defaultBranch = symbolicHead.slice(preferredRemote.name.length + 1);
    }
    if (defaultBranch === null) {
      for (const candidate of ["main", "master", "develop"]) {
        const ref = `refs/remotes/${preferredRemote.name}/${candidate}`;
        const exists = await runGit(
          ["show-ref", "--quiet", "--verify", ref],
          repository,
          signal,
        );
        if (exists.code === 0) {
          defaultBranch = candidate;
          break;
        }
      }
    }
  }
  if (defaultBranch === null) {
    for (const candidate of ["main", "master", "develop"]) {
      const exists = await runGit(
        ["show-ref", "--quiet", "--verify", `refs/heads/${candidate}`],
        repository,
        signal,
      );
      if (exists.code === 0) {
        defaultBranch = candidate;
        break;
      }
    }
  }
  if (defaultBranch === null && upstream !== "") {
    const slash = upstream.indexOf("/");
    defaultBranch = slash < 0 ? upstream : upstream.slice(slash + 1);
  }

  const branchName = branch || null;
  const baseBranch =
    preferredRemote !== undefined && defaultBranch !== null
      ? `${preferredRemote.name}/${defaultBranch}`
      : defaultBranch;
  const statusText = await gitText(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    repository,
    signal,
  );
  const changes = parseChangedFiles(statusText);
  let ahead = 0;
  let behind = 0;
  if (upstream !== "") {
    const counts = await gitText(
      ["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
      repository,
      signal,
    ).catch(() => "");
    const [left, right] = counts.trim().split(/\s+/u).map(Number);
    behind = Number.isFinite(left) ? left! : 0;
    ahead = Number.isFinite(right) ? right! : 0;
  }

  let branchChanges: Array<{ path: string; status: string }> = [];
  if (branchName !== null && baseBranch !== null) {
    const branchDiff = await runGit(
      ["diff", "--name-status", "-z", "--no-renames", `${baseBranch}...HEAD`, "--"],
      repository,
      signal,
    );
    if (branchDiff.code === 0) branchChanges = parseBranchFiles(branchDiff.stdout);
  }

  return {
    repoPath,
    branch: branchName,
    upstream: upstream || null,
    ahead,
    behind,
    defaultBranch,
    baseBranch,
    isDefaultBranch: branchName !== null && branchName === defaultBranch,
    remotes,
    changes,
    branchChanges,
  };
}

async function filePatch(
  repository: string,
  filePath: string,
  signal: AbortSignal,
): Promise<string> {
  resolveFile(repository, filePath);
  const result = await runGit(
    [
      "diff",
      "--no-index",
      "--no-color",
      "--no-ext-diff",
      "--",
      process.platform === "win32" ? "NUL" : "/dev/null",
      filePath,
    ],
    repository,
    signal,
  );
  if (result.code === 0 || result.code === 1) return result.stdout;
  return "";
}

async function diffForFile(
  root: string,
  repoPath: string,
  filePath: string,
  signal: AbortSignal,
) {
  const repository = await assertRepository(root, repoPath, signal);
  resolveFile(repository, filePath);
  const status = await inspectRepository(root, repoPath, signal);
  const stagedRaw = await gitText(
    ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-renames", "--", filePath],
    repository,
    signal,
  );
  let unstagedRaw = await gitText(
    ["diff", "--no-color", "--no-ext-diff", "--no-renames", "--", filePath],
    repository,
    signal,
  );
  if (unstagedRaw === "" && status.changes.some((change) => change.path === filePath && change.untracked)) {
    unstagedRaw = await filePatch(repository, filePath, signal);
  }
  let branchRaw = "";
  if (status.baseBranch !== null && status.branch !== null) {
    branchRaw = await gitText(
      ["diff", "--no-color", "--no-ext-diff", "--no-renames", status.baseBranch + "...HEAD", "--", filePath],
      repository,
      signal,
    );
  }
  const staged = clipped(stagedRaw);
  const unstaged = clipped(unstagedRaw);
  const branch = clipped(branchRaw);
  return {
    staged: staged.text,
    unstaged: unstaged.text,
    branch: branch.text,
    truncated: staged.truncated || unstaged.truncated || branch.truncated,
  };
}

async function stagedContext(
  repository: string,
  signal: AbortSignal,
): Promise<string> {
  const diff = await gitText(
    ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-renames"],
    repository,
    signal,
  );
  return diff;
}

async function branchContext(
  root: string,
  repoPath: string,
  signal: AbortSignal,
): Promise<string> {
  const status = await inspectRepository(root, repoPath, signal);
  const repository = resolveRepository(root, repoPath);
  const sections: string[] = [];
  if (status.baseBranch !== null && status.branch !== null) {
    sections.push(
      await gitText(
        ["diff", "--no-color", "--no-ext-diff", "--no-renames", `${status.baseBranch}...HEAD`],
        repository,
        signal,
      ),
    );
  }
  return sections.filter(Boolean).join("\n");
}

function selectedHunks(patch: string, indexes: readonly number[]): string {
  const lines = patch.split("\n");
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("@@ ")) starts.push(index);
  }
  if (starts.length === 0) throw new Error("This diff has no text hunks to stage");
  const header = lines.slice(0, starts[0]);
  const hunks = starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length),
  );
  const unique = [...new Set(indexes)].sort((a, b) => a - b);
  if (unique.some((index) => index >= hunks.length)) {
    throw new Error("The diff changed; refresh it and choose the hunk again");
  }
  return [...header, ...unique.flatMap((index) => hunks[index]!)].join("\n");
}

async function applyHunks(
  repository: string,
  patch: string,
  reverse: boolean,
  signal: AbortSignal,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bb-files-editor-"));
  const patchPath = path.join(directory, "selected.patch");
  try {
    await writeFile(patchPath, patch, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const args = [
      "apply",
      "--cached",
      "--whitespace=nowarn",
      ...(reverse ? ["--reverse"] : []),
      patchPath,
    ];
    await gitText(args, repository, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export default experimental_defineHostEntry({
  contract: gitHostContract,
  handlers: {
    async discoverRepositories({ root, excludedNames }, context) {
      const absoluteRoot = path.resolve(root);
      const excluded = new Set(excludedNames.filter((name) => name !== ".git"));
      const repoPaths: string[] = [];
      const pending = [{ absolute: absoluteRoot, relative: "" }];
      let visited = 0;
      while (pending.length > 0 && visited < MAX_DISCOVERED_DIRECTORIES) {
        const current = pending.pop()!;
        visited += 1;
        let entries;
        try {
          entries = await readdir(current.absolute, { withFileTypes: true });
        } catch {
          continue;
        }
        const hasMarker = entries.some(
          (entry) =>
            entry.name === ".git" &&
            (entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()),
        );
        if (hasMarker) {
          repoPaths.push(current.relative);
          if (repoPaths.length >= MAX_DISCOVERED_REPOSITORIES) break;
        }
        for (const entry of entries) {
          if (
            entry.name === ".git" ||
            excluded.has(entry.name) ||
            !entry.isDirectory() ||
            entry.isSymbolicLink()
          ) {
            continue;
          }
          pending.push({
            absolute: path.join(current.absolute, entry.name),
            relative:
              current.relative === ""
                ? entry.name
                : `${current.relative}/${entry.name}`,
          });
        }
      }
      return {
        repoPaths: repoPaths.sort((a, b) => a.localeCompare(b)),
        truncated:
          pending.length > 0 || visited >= MAX_DISCOVERED_DIRECTORIES,
      };
    },
    async status({ root, repoPath }, context) {
      return inspectRepository(root, repoPath, context.signal);
    },
    async diff({ root, repoPath, path: filePath }, context) {
      return diffForFile(root, repoPath, filePath, context.signal);
    },
    async context({ root, repoPath, kind }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      const text =
        kind === "staged"
          ? await stagedContext(repository, context.signal)
          : await branchContext(root, repoPath, context.signal);
      const result = clipped(text, 90_000);
      return { text: result.text, truncated: result.truncated };
    },
    async stageFile({ root, repoPath, path: filePath, stage }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      resolveFile(repository, filePath);
      if (stage) {
        await gitText(["add", "--", filePath], repository, context.signal);
      } else {
        await gitText(["reset", "-q", "--", filePath], repository, context.signal);
      }
      return { ok: true as const };
    },
    async stageAll({ root, repoPath }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      await gitText(["add", "-A"], repository, context.signal);
      return { ok: true as const };
    },
    async stageHunks({ root, repoPath, path: filePath, kind, hunkIndexes }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      resolveFile(repository, filePath);
      const status = await inspectRepository(root, repoPath, context.signal);
      let patch =
        kind === "staged"
          ? await gitText(
              ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-renames", "--", filePath],
              repository,
              context.signal,
            )
          : await gitText(
              ["diff", "--no-color", "--no-ext-diff", "--no-renames", "--", filePath],
              repository,
              context.signal,
            );
      if (
        kind === "unstaged" &&
        patch === "" &&
        status.changes.some((change) => change.path === filePath && change.untracked)
      ) {
        patch = await filePatch(repository, filePath, context.signal);
      }
      const selection = selectedHunks(patch, hunkIndexes);
      await applyHunks(repository, selection, kind === "staged", context.signal);
      return { ok: true as const };
    },
    async commit({ root, repoPath, message }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      await gitText(
        ["-c", "credential.interactive=never", "commit", "-m", message],
        repository,
        context.signal,
        { timeoutMs: 120_000 },
      );
      const hash = await gitText(["rev-parse", "HEAD"], repository, context.signal);
      const subject = await gitText(["log", "-1", "--format=%s"], repository, context.signal);
      return { ok: true as const, hash, subject };
    },
    async push({ root, repoPath, remote, branch }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      const args = ["-c", "credential.interactive=never", "push"];
      if (remote !== null && branch !== null) {
        if (remote.startsWith("-") || branch.startsWith("-")) {
          throw new Error("Invalid push target");
        }
        const remotes = (await gitText(["remote"], repository, context.signal))
          .split("\n")
          .filter(Boolean);
        if (!remotes.includes(remote)) {
          throw new Error("Choose a configured remote for this repository");
        }
        await gitText(["check-ref-format", "--branch", branch], repository, context.signal);
        args.push("--set-upstream", remote, branch);
      } else if (remote !== null || branch !== null) {
        throw new Error("Both a remote and branch are required for a new upstream");
      }
      await gitText(args, repository, context.signal, { timeoutMs: 120_000 });
      return { ok: true as const };
    },
    async createBranch({ root, repoPath, branch }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      if (branch.startsWith("-")) throw new Error("Invalid branch name");
      await gitText(["check-ref-format", "--branch", branch], repository, context.signal);
      await gitText(["switch", "-c", branch], repository, context.signal, {
        timeoutMs: 60_000,
      });
      return {
        ok: true as const,
        branch: await gitText(["branch", "--show-current"], repository, context.signal),
      };
    },
    async githubRepository({ root, repoPath, repo }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      return githubRepositoryInfo(repository, repo, context.signal);
    },
    async pullRequest({ root, repoPath, repo, number }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      return githubPullRequest(repository, repo, context.signal, number);
    },
    async createPullRequest(
      { root, repoPath, repo, title, body, base, head, draft },
      context,
    ) {
      const repository = await assertRepository(root, repoPath, context.signal);
      const currentBranch = await gitText(
        ["branch", "--show-current"],
        repository,
        context.signal,
      );
      if (currentBranch !== head) {
        throw new Error("The branch changed. Refresh Source Control and try again.");
      }
      const validBase = await runGit(
        ["check-ref-format", "--branch", base],
        repository,
        context.signal,
      );
      if (validBase.code !== 0) throw new Error("Enter a valid base branch name.");
      const output = await ghText(
        [
          "pr",
          "create",
          "--repo",
          repo,
          "--title",
          title,
          "--body",
          body,
          "--base",
          base,
          "--head",
          head,
          ...(draft ? ["--draft"] : []),
        ],
        repository,
        context.signal,
        { timeoutMs: 120_000 },
      );
      const url = output.match(/https?:\/\/[^\s]+\/pull\/(\d+)\/?/iu);
      if (url === null) {
        throw new Error("GitHub did not return the created pull request URL.");
      }
      return {
        ok: true as const,
        number: Number(url[1]),
        url: url[0].replace(/\/$/u, ""),
      };
    },
    async mergePullRequest({ root, repoPath, repo, number, method }, context) {
      const repository = await assertRepository(root, repoPath, context.signal);
      const info = await githubRepositoryInfo(repository, repo, context.signal);
      if (!info.mergeMethods.includes(method)) {
        throw new Error("That merge method is disabled for this repository.");
      }
      const { pull } = await githubPullRequest(
        repository,
        repo,
        context.signal,
        number,
      );
      if (pull === null || pull.state !== "OPEN" || pull.isDraft) {
        throw new Error("Only open, ready-for-review pull requests can be merged.");
      }
      await ghText(
        ["pr", "merge", String(number), "--repo", repo, `--${method}`],
        repository,
        context.signal,
        { timeoutMs: 120_000 },
      );
      return { ok: true as const };
    },
  },
});
