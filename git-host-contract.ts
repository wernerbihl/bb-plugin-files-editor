import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const repositoryInputSchema = z
  .object({
    root: z.string().min(1),
    repoPath: z.string(),
  })
  .strict();

const changedFileSchema = z
  .object({
    path: z.string(),
    previousPath: z.string().nullable(),
    status: z.string(),
    staged: z.boolean(),
    unstaged: z.boolean(),
    untracked: z.boolean(),
  })
  .strict();

const branchFileSchema = z
  .object({ path: z.string(), status: z.string() })
  .strict();

const remoteSchema = z
  .object({ name: z.string(), url: z.string() })
  .strict();

const githubRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

const mergeMethodSchema = z.enum(["merge", "squash", "rebase"]);

const pullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    isDraft: z.boolean(),
    mergeMethods: z.array(mergeMethodSchema),
    url: z.string().url(),
    baseRefName: z.string(),
    headRefName: z.string(),
    reviewDecision: z.string(),
    mergeStateStatus: z.string(),
    checks: z
      .array(
        z
          .object({
            name: z.string(),
            status: z.enum(["success", "failure", "pending", "neutral"]),
            url: z.string(),
          })
          .strict(),
      ),
  })
  .strict();

export const gitHostContract = defineRpcContract({
  discoverRepositories: {
    input: z
      .object({
        root: z.string().min(1),
        excludedNames: z.array(z.string().min(1)).max(200),
      })
      .strict(),
    output: z
      .object({
        repoPaths: z.array(z.string()),
        truncated: z.boolean(),
      })
      .strict(),
  },
  status: {
    input: repositoryInputSchema,
    output: z
      .object({
        repoPath: z.string(),
        branch: z.string().nullable(),
        upstream: z.string().nullable(),
        ahead: z.number().int().nonnegative(),
        behind: z.number().int().nonnegative(),
        defaultBranch: z.string().nullable(),
        baseBranch: z.string().nullable(),
        isDefaultBranch: z.boolean(),
        remotes: z.array(remoteSchema),
        changes: z.array(changedFileSchema),
        branchChanges: z.array(branchFileSchema),
      })
      .strict(),
  },
  diff: {
    input: repositoryInputSchema
      .extend({ path: z.string().min(1) })
      .strict(),
    output: z
      .object({
        staged: z.string(),
        unstaged: z.string(),
        branch: z.string(),
        truncated: z.boolean(),
      })
      .strict(),
  },
  context: {
    input: repositoryInputSchema
      .extend({ kind: z.enum(["staged", "branch"]) })
      .strict(),
    output: z.object({ text: z.string(), truncated: z.boolean() }).strict(),
  },
  stageFile: {
    input: repositoryInputSchema
      .extend({ path: z.string().min(1), stage: z.boolean() })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  stageAll: {
    input: repositoryInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  stageHunks: {
    input: repositoryInputSchema
      .extend({
        path: z.string().min(1),
        kind: z.enum(["staged", "unstaged"]),
        hunkIndexes: z.array(z.number().int().nonnegative()).min(1).max(200),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  commit: {
    input: repositoryInputSchema
      .extend({ message: z.string().trim().min(1).max(5_000) })
      .strict(),
    output: z
      .object({
        ok: z.literal(true),
        hash: z.string().min(1),
        subject: z.string(),
      })
      .strict(),
  },
  push: {
    input: repositoryInputSchema
      .extend({
        remote: z.string().min(1).nullable(),
        branch: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  createBranch: {
    input: repositoryInputSchema
      .extend({ branch: z.string().trim().min(1).max(200) })
      .strict(),
    output: z.object({ ok: z.literal(true), branch: z.string() }).strict(),
  },
  githubRepository: {
    input: repositoryInputSchema
      .extend({ repo: githubRepositorySchema })
      .strict(),
    output: z
      .object({
        defaultBranch: z.string().min(1),
        mergeMethods: z.array(mergeMethodSchema),
        url: z.string().url(),
      })
      .strict(),
  },
  pullRequest: {
    input: repositoryInputSchema
      .extend({ repo: githubRepositorySchema, number: z.number().int().positive().optional() })
      .strict(),
    output: z.object({ pull: pullRequestSchema.nullable() }).strict(),
  },
  createPullRequest: {
    input: repositoryInputSchema
      .extend({
        repo: githubRepositorySchema,
        title: z.string().trim().min(1).max(256),
        body: z.string().max(50_000),
        base: z.string().trim().min(1).max(255),
        head: z.string().trim().min(1).max(255),
        draft: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        ok: z.literal(true),
        number: z.number().int().positive(),
        url: z.string().url(),
      })
      .strict(),
  },
  mergePullRequest: {
    input: repositoryInputSchema
      .extend({
        repo: githubRepositorySchema,
        number: z.number().int().positive(),
        method: mergeMethodSchema,
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
