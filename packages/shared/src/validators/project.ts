import { z } from "zod";
import type { ProjectQaIntegrationConfig, ProjectQaIntegrationRepositoryConfig } from "../types/project.js";
import { PROJECT_STATUSES, PROJECT_ICON_NAMES } from "../constants.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema } from "./trust-policy.js";
import { objectWithoutDefaults } from "./partial.js";

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    runtimeProvisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const projectExecutionWorkspacePolicySchema = z
  .object({
    enabled: z.boolean(),
    sharedWorkspaceConcurrency: z.enum(["auto", "serialize", "allow"]).optional(),
    defaultMode: z.enum(["shared_workspace", "isolated_workspace", "operator_branch", "adapter_default"]).optional(),
    allowIssueOverride: z.boolean().optional(),
    defaultProjectWorkspaceId: z.string().guid().optional().nullable(),
    environmentId: z.string().guid().optional().nullable(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
    branchPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    pullRequestPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    runtimePolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    cleanupPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    authorizationPolicy: trustAuthorizationPolicySchema.optional().nullable(),
  })
  .strict();

export const projectWorkspaceRuntimeConfigSchema = z.object({
  workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  desiredState: z.enum(["running", "stopped", "manual"]).optional().nullable(),
  serviceStates: z.record(z.string(), z.enum(["running", "stopped", "manual"])).optional().nullable(),
}).strict();

const projectWorkspaceSourceTypeSchema = z.enum(["local_path", "git_repo", "remote_managed", "non_git_path"]);
const projectWorkspaceVisibilitySchema = z.enum(["default", "advanced"]);

export const projectQaIntegrationCommandSchema = z.object({
  name: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 ._-]+$/),
  command: z.string().trim().min(1).max(2000),
  timeoutSeconds: z.number().int().min(30).max(3600).optional(),
}).strict();

const relativePathSegment = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

const projectQaIntegrationPathFields = {
  migrationDirectories: z.array(z.string().refine((value) =>
    value.split("/").every((segment) => segment === "*" || relativePathSegment.test(segment)),
  "Expected a relative POSIX path without parent traversal")).max(20).optional(),
  autoResolveAdditivePaths: z.array(z.string().refine((value) =>
    value.split("/").every((segment) => relativePathSegment.test(segment)),
  "Expected an exact relative POSIX path without parent traversal")).max(20).optional(),
};

const projectQaIntegrationCommandsSchema = z.array(projectQaIntegrationCommandSchema).min(1).max(10);

export const projectQaIntegrationRepositoryConfigSchema = z.object({
  commands: projectQaIntegrationCommandsSchema,
  ...projectQaIntegrationPathFields,
}).strict().superRefine((integration, ctx) => {
  if (integration.autoResolveAdditivePaths?.length && !integration.commands.length) {
    ctx.addIssue({
      code: "custom",
      path: ["autoResolveAdditivePaths"],
      message: "autoResolveAdditivePaths requires integration commands",
    });
  }
});

export const projectQaIntegrationConfigSchema = z.object({
  commands: projectQaIntegrationCommandsSchema.optional(),
  ...projectQaIntegrationPathFields,
  repositories: z.record(
    z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/, "Expected lowercase owner/repo"),
    projectQaIntegrationRepositoryConfigSchema,
  ).refine((value) => Object.keys(value).length <= 20, "At most 20 repositories").optional(),
}).strict().superRefine((integration, ctx) => {
  if (!integration.commands?.length && !Object.keys(integration.repositories ?? {}).length) {
    ctx.addIssue({ code: "custom", path: ["commands"], message: "integration requires commands or repositories" });
  }
  if (integration.autoResolveAdditivePaths?.length && !integration.commands?.length) {
    ctx.addIssue({
      code: "custom",
      path: ["autoResolveAdditivePaths"],
      message: "autoResolveAdditivePaths requires integration commands",
    });
  }
});

export function resolveQaIntegrationConfigForRepository(
  config: ProjectQaIntegrationConfig | null | undefined,
  owner: string,
  repo: string,
): ProjectQaIntegrationRepositoryConfig | null {
  if (!config) return null;
  const key = `${owner}/${repo}`.toLowerCase();
  for (const [name, entry] of Object.entries(config.repositories ?? {})) {
    if (name.toLowerCase() === key) return entry;
  }
  if (!config.commands?.length) return null;
  return {
    commands: config.commands,
    ...(config.migrationDirectories ? { migrationDirectories: config.migrationDirectories } : {}),
    ...(config.autoResolveAdditivePaths ? { autoResolveAdditivePaths: config.autoResolveAdditivePaths } : {}),
  };
}

export const projectQaPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("staged") }).strict(),
  z.object({
    mode: z.literal("final"),
    finalQaAgentId: z.string().uuid(),
    mergeApproverUserId: z.string().trim().min(1).optional(),
    integration: projectQaIntegrationConfigSchema.optional(),
  }).strict(),
]);

const qaNonEmptyTextSchema = z.string().trim().min(1);

const qaCodeCheckSchema = z.object({
  kind: z.enum(["diff", "test", "security", "migration", "contract"]),
  evidence: qaNonEmptyTextSchema,
}).strict();

const qaCodePhaseEvidenceSchema = z.object({
  outcome: z.literal("pass"),
  checks: z.array(qaCodeCheckSchema).min(1),
}).strict();

const qaBrowserEvidenceSchema = z.object({
  kind: z.enum(["url", "screenshot", "console", "network"]),
  value: qaNonEmptyTextSchema,
}).strict();

const qaBrowserPassPhaseEvidenceSchema = z.object({
  outcome: z.literal("pass"),
  reason: qaNonEmptyTextSchema,
  evidence: z.array(qaBrowserEvidenceSchema).min(1),
}).strict();

const qaBrowserNotApplicablePhaseEvidenceSchema = z.object({
  outcome: z.literal("not_applicable"),
  reason: qaNonEmptyTextSchema,
  evidence: z.tuple([]),
}).strict();

const qaBrowserPhaseEvidenceSchema = z.discriminatedUnion("outcome", [
  qaBrowserPassPhaseEvidenceSchema,
  qaBrowserNotApplicablePhaseEvidenceSchema,
]);

const qaSpecCriterionSchema = z.object({
  criterion: qaNonEmptyTextSchema,
  evidence: qaNonEmptyTextSchema,
}).strict();

const qaSpecPhaseEvidenceSchema = z.object({
  outcome: z.literal("pass"),
  criteria: z.array(qaSpecCriterionSchema).min(1),
}).strict();

const qaPhaseEvidenceSchema = z.object({
  code: qaCodePhaseEvidenceSchema,
  browser: qaBrowserPhaseEvidenceSchema,
  spec: qaSpecPhaseEvidenceSchema,
}).strict();

const qaReviewHandoffSchema = z.object({
  kind: z.enum(["pull_request", "work_product"]),
  id: qaNonEmptyTextSchema,
  url: z.string().url().nullable(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
}).strict();

export const qaReviewEvidenceV1Schema = z.object({
  version: z.literal(1),
  mode: z.literal("final"),
  projectId: z.string().uuid(),
  reviewerAgentId: z.string().uuid(),
  phases: qaPhaseEvidenceSchema,
  handoff: qaReviewHandoffSchema,
}).strict();

export const qaReviewEvidenceV2Schema = z.object({
  version: z.literal(2),
  mode: z.literal("final"),
  projectId: z.string().uuid(),
  reviewerAgentId: z.string().uuid(),
  phases: qaPhaseEvidenceSchema,
  handoffs: z.array(qaReviewHandoffSchema).min(1).max(20),
}).strict().superRefine((evidence, ctx) => {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  evidence.handoffs.forEach((handoff, index) => {
    const idKey = `${handoff.kind}\u0000${handoff.id}`;
    const urlKey = handoff.url?.toLowerCase() ?? null;
    if (seenIds.has(idKey) || (urlKey !== null && seenUrls.has(urlKey))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["handoffs", index], message: "duplicate QA handoff" });
    }
    seenIds.add(idKey);
    if (urlKey !== null) seenUrls.add(urlKey);
  });
});

export const qaReviewEvidenceSchema = z.union([qaReviewEvidenceV2Schema, qaReviewEvidenceV1Schema]);

const projectWorkspaceFields = {
  name: z.string().min(1).optional(),
  sourceType: projectWorkspaceSourceTypeSchema.optional(),
  cwd: z.string().min(1).optional().nullable(),
  repoUrl: z.string().url().optional().nullable(),
  repoRef: z.string().optional().nullable(),
  defaultRef: z.string().optional().nullable(),
  visibility: projectWorkspaceVisibilitySchema.optional(),
  setupCommand: z.string().optional().nullable(),
  cleanupCommand: z.string().optional().nullable(),
  remoteProvider: z.string().optional().nullable(),
  remoteWorkspaceRef: z.string().optional().nullable(),
  sharedWorkspaceKey: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  runtimeConfig: projectWorkspaceRuntimeConfigSchema.optional().nullable(),
};

function validateProjectWorkspace(value: Record<string, unknown>, ctx: z.RefinementCtx) {
  const sourceType = value.sourceType ?? "local_path";
  const hasCwd = typeof value.cwd === "string" && value.cwd.trim().length > 0;
  const hasRepo = typeof value.repoUrl === "string" && value.repoUrl.trim().length > 0;
  const hasRemoteRef = typeof value.remoteWorkspaceRef === "string" && value.remoteWorkspaceRef.trim().length > 0;

  if (sourceType === "remote_managed") {
    if (!hasRemoteRef && !hasRepo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Remote-managed workspace requires remoteWorkspaceRef or repoUrl.",
        path: ["remoteWorkspaceRef"],
      });
    }
    return;
  }

  if (!hasCwd && !hasRepo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workspace requires at least one of cwd or repoUrl.",
      path: ["cwd"],
    });
  }
}

export const createProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional().default(false),
}).superRefine(validateProjectWorkspace);

export type CreateProjectWorkspace = z.infer<typeof createProjectWorkspaceSchema>;

export const updateProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional(),
}).partial();

export type UpdateProjectWorkspace = z.infer<typeof updateProjectWorkspaceSchema>;

const projectFields = {
  /** @deprecated Use goalIds instead */
  goalId: z.string().guid().optional().nullable(),
  goalIds: z.array(z.string().guid()).optional(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(PROJECT_STATUSES).optional().default("backlog"),
  leadAgentId: z.string().guid().optional().nullable(),
  targetDate: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  icon: z.enum(PROJECT_ICON_NAMES).optional().nullable(),
  env: envConfigSchema.optional().nullable(),
  qaPolicy: projectQaPolicySchema.optional().nullable(),
  executionWorkspacePolicy: projectExecutionWorkspacePolicySchema.optional().nullable(),
  archivedAt: z.string().datetime().optional().nullable(),
};

export const createProjectSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
  ...projectFields,
  workspace: createProjectWorkspaceSchema.optional(),
  repositoryIds: z.array(z.string().regex(/^\d+$/)).optional(),
  repositoryUrls: z.array(z.string().url().max(2000)).max(100).optional(),
});

export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = objectWithoutDefaults(
  z.object(projectFields),
).partial();

export type UpdateProject = z.infer<typeof updateProjectSchema>;

export type ProjectExecutionWorkspacePolicy = z.infer<typeof projectExecutionWorkspacePolicySchema>;
