# QA Specs Gate Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure QA Code can skip QA Browser for backend-only work, but can never skip QA Specs.

**Architecture:** Keep the existing default QA routing in `server/src/routes/issues.ts`, add an explicit API hint for browser-applicability, and route `QA Code PASS + backend-only` to `QA Specs` instead of `done`. Preserve the existing `QA Code -> QA Browser -> QA Specs -> done` path for work where browser QA is required or unspecified.

**Tech Stack:** Express route validation with Zod, shared issue update types, Vitest route tests, React API types where needed.

## Global Constraints

- Keep changes company-scoped and preserve existing issue mutation authorization.
- Do not infer backend-only from titles, PR files, or agent prose.
- Only `QA Specs` may complete an issue after QA pass.
- `QA Code` and `QA Browser` attempts to close `done` must be rejected unless the request is transformed into a valid next QA assignment.
- Use targeted tests first; run broader checks only if touched contracts require them.

---

## Files

- Modify: `server/src/routes/issues.ts`
  - Extend `updateIssueRouteSchema` with a browser-scope hint.
  - Pass the hint into `applyDefaultQaDispositionRouting`.
  - Route `QA Code PASS` to `QA Specs` when browser QA is explicitly not applicable.
  - Reject direct `done` from all non-Spec QA paths.
- Modify: `server/src/__tests__/issue-execution-policy-routes.test.ts`
  - Add regression tests for backend-only `QA Code PASS -> QA Specs`.
  - Add regression tests that `QA Code` cannot close `done` directly when `QA Specs` exists.
  - Preserve the existing `QA Code PASS -> QA Browser` test.
- Modify: `packages/shared/src/validators/issue.ts`
  - Add the new optional request property to `updateIssueSchema` if this contract is shared with UI/API clients.
- Modify: `packages/shared/src/types/issue.ts`
  - Add the corresponding type field if `UpdateIssue` consumers need it explicitly.
- Modify: `ui/src/api/issues.ts`
  - Only if TypeScript requires the API client type to know the new field.

## Proposed API Contract

Use a narrow optional field:

```ts
qaBrowserScope?: "required" | "not_applicable";
```

Semantics:

- Omitted or `"required"`: `QA Code PASS` routes to `QA Browser` when a browser QA agent exists, otherwise falls back to `QA Specs`.
- `"not_applicable"`: `QA Code PASS` skips browser and routes to `QA Specs` when a spec QA agent exists.
- `"not_applicable"` never lets `QA Code` close `done`; if no `QA Specs` agent exists, the update must fail with `422 invalid_qa_disposition` rather than silently completing.
- Any non-Spec QA pass with no valid downstream QA agent must fail with `422 invalid_qa_disposition`; missing downstream reviewers must never be interpreted as permission to close.

---

### Task 1: Add Regression Tests For Backend-Only QA Routing

**Files:**
- Modify: `server/src/__tests__/issue-execution-policy-routes.test.ts`

**Interfaces:**
- Consumes: existing `PATCH /api/issues/:id` test harness and `qaVerdict`.
- Produces: failing tests that define the expected `qaBrowserScope` behavior.

- [ ] **Step 1: Add a failing test for backend-only Code QA pass**

Add this test near the existing QA pass routing tests:

```ts
it("advances backend-only Code QA PASS directly to Spec QA", async () => {
  const codeQaId = "44444444-4444-4444-8444-444444444444";
  const browserQaId = "55555555-5555-4555-8555-555555555555";
  const specQaId = "66666666-6666-4666-8666-666666666666";
  const issue = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_review",
    assigneeAgentId: codeQaId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "NSS-452",
    title: "Backend-only billing cleanup",
    executionPolicy: null,
    executionState: null,
  };
  mockIssueService.getById.mockResolvedValue(issue);
  mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }));
  mockAgentService.getById.mockImplementation(async (agentId: string) => ({
    id: agentId,
    companyId: "company-1",
    role: "qa",
    name: agentId === browserQaId ? "QA (Browser)" : agentId === specQaId ? "QA (Spec)" : "QA (Code)",
    status: "idle",
    permissions: null,
    orgChainHealth: { status: "healthy" },
  }));
  mockDbSelectWhere.mockImplementation(() => ({
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve([
        { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        { id: browserQaId, companyId: "company-1", role: "qa", name: "QA (Browser)", status: "idle" },
        { id: specQaId, companyId: "company-1", role: "qa", name: "QA (Spec)", status: "idle" },
      ]).then(onFulfilled, onRejected),
  }));
  mockAccessService.hasPermission.mockResolvedValue(true);

  const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
    .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    .send({ qaVerdict: "pass", qaBrowserScope: "not_applicable" });

  expect(res.status).toBe(200);
  expect(mockIssueService.update).toHaveBeenCalledWith(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expect.objectContaining({
      status: "in_review",
      assigneeAgentId: specQaId,
      assigneeUserId: null,
    }),
  );
});
```

- [ ] **Step 2: Add a failing test for missing Spec QA**

```ts
it("rejects backend-only Code QA PASS when no Spec QA agent exists", async () => {
  const codeQaId = "44444444-4444-4444-8444-444444444444";
  const browserQaId = "55555555-5555-4555-8555-555555555555";
  const issue = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_review",
    assigneeAgentId: codeQaId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "NSS-452",
    title: "Backend-only billing cleanup",
    executionPolicy: null,
    executionState: null,
  };
  mockIssueService.getById.mockResolvedValue(issue);
  mockAgentService.getById.mockImplementation(async (agentId: string) => ({
    id: agentId,
    companyId: "company-1",
    role: "qa",
    name: agentId === browserQaId ? "QA (Browser)" : "QA (Code)",
    status: "idle",
    permissions: null,
    orgChainHealth: { status: "healthy" },
  }));
  mockDbSelectWhere.mockImplementation(() => ({
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve([
        { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
        { id: browserQaId, companyId: "company-1", role: "qa", name: "QA (Browser)", status: "idle" },
      ]).then(onFulfilled, onRejected),
  }));

  const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
    .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    .send({ qaVerdict: "pass", qaBrowserScope: "not_applicable" });

  expect(res.status).toBe(422);
  expect(res.body.details).toMatchObject({
    code: "invalid_qa_disposition",
    missing: "spec_qa_agent",
  });
  expect(mockIssueService.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the focused failing tests**

Run:

```bash
pnpm --filter @paperclipai/server test -- issue-execution-policy-routes
```

Expected before implementation: at least the new backend-only tests fail because `qaBrowserScope` is not implemented.

---

### Task 2: Implement Explicit Backend-Only QA Routing

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `packages/shared/src/validators/issue.ts`

**Interfaces:**
- Consumes: request body field `qaBrowserScope?: "required" | "not_applicable"`.
- Produces: routing behavior used by the tests in Task 1.

- [ ] **Step 1: Add the route schema field**

In `server/src/routes/issues.ts`, change `updateIssueRouteSchema` to include:

```ts
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
  qaVerdict: z.enum(["pass", "fail"]).optional(),
  qaBrowserScope: z.enum(["required", "not_applicable"]).optional(),
});
```

- [ ] **Step 2: Extract the field from the request body**

In the `router.patch("/issues/:id", ...)` destructuring, include:

```ts
const {
  comment: commentBody,
  qaVerdict,
  qaBrowserScope,
  reviewRequest,
  reopen: reopenRequested,
  resume: resumeRequested,
  interrupt: interruptRequested,
  hiddenAt: hiddenAtRaw,
  ...updateFields
} = req.body;
```

- [ ] **Step 3: Pass the field into the routing helper**

Update the `applyDefaultQaDispositionRouting` call:

```ts
await applyDefaultQaDispositionRouting({
  existing,
  updateFields,
  actorAgentId: actor.agentId ?? null,
  qaVerdict,
  qaBrowserScope,
});
```

- [ ] **Step 4: Extend the helper signature**

In `applyDefaultQaDispositionRouting`, add:

```ts
qaBrowserScope?: "required" | "not_applicable";
```

- [ ] **Step 5: Add a focused resolver for Spec QA**

Near `resolveNextQaAgent`, add:

```ts
async function resolveSpecQaAgent(companyId: string) {
  const assignable = await listAssignableQaAgents(companyId);
  return assignable.find(agentLooksLikeSpecQa) ?? null;
}
```

- [ ] **Step 6: Route backend-only Code QA pass to Spec QA**

Inside the `if (input.qaVerdict === "pass")` block, before `resolveNextQaAgent`, add:

```ts
if (currentStage === "code" && input.qaBrowserScope === "not_applicable") {
  const specQaAgent = await resolveSpecQaAgent(input.existing.companyId);
  if (!specQaAgent) {
    throw unprocessable("Backend-only QA pass requires a Spec QA agent before completion", {
      code: "invalid_qa_disposition",
      missing: "spec_qa_agent",
    });
  }
  input.updateFields.status = "in_review";
  input.updateFields.assigneeAgentId = specQaAgent.id;
  input.updateFields.assigneeUserId = null;
  return;
}
```

- [ ] **Step 7: Share the contract if TypeScript requires it**

If compile errors show `qaBrowserScope` is rejected by shared client types, extend `packages/shared/src/validators/issue.ts`:

```ts
export const updateIssueSchema = createIssueBaseSchema.omit({ watchdog: true }).partial().extend({
  requestDepth: issueRequestDepthInputSchema.optional(),
  assigneeAgentId: z.string().trim().min(1).optional().nullable(),
  comment: multilineTextSchema.pipe(z.string().min(1)).optional(),
  reviewRequest: issueReviewRequestSchema.optional().nullable(),
  qaBrowserScope: z.enum(["required", "not_applicable"]).optional(),
  reopen: z.boolean().optional(),
  resume: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
});
```

- [ ] **Step 8: Run the focused test**

Run:

```bash
pnpm --filter @paperclipai/server test -- issue-execution-policy-routes
```

Expected: the new tests and the existing QA routing tests pass.

---

### Task 3: Harden Legacy Direct Completion From Non-Spec QA

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/__tests__/issue-execution-policy-routes.test.ts`

**Interfaces:**
- Consumes: existing update route behavior.
- Produces: regression coverage for the observed NSS-452 failure mode and for the generic no-next-QA fallback.

- [ ] **Step 1: Add a regression test for `QA Code` direct completion**

If the existing test only covers `status: "done"` without a comment, add a variant that mirrors the observed run:

```ts
it("rejects Code QA direct done even when posting a PASS comment", async () => {
  const codeQaId = "44444444-4444-4444-8444-444444444444";
  const issue = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_review",
    assigneeAgentId: codeQaId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "NSS-452",
    title: "Backend-only billing cleanup",
    executionPolicy: null,
    executionState: null,
  };
  mockIssueService.getById.mockResolvedValue(issue);
  mockAgentService.getById.mockResolvedValue({
    id: codeQaId,
    companyId: "company-1",
    role: "qa",
    name: "QA (Code)",
    status: "idle",
    permissions: null,
    orgChainHealth: { status: "healthy" },
  });

  const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
    .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    .send({ status: "done", comment: "## QA CODE PASS\n\nBackend-only change looks good." });

  expect(res.status).toBe(422);
  expect(res.body.details).toMatchObject({
    code: "invalid_qa_disposition",
    required: "qaVerdict",
  });
  expect(mockIssueService.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add a regression test for Browser QA pass when Spec QA is missing**

```ts
it("rejects Browser QA PASS when no Spec QA agent exists", async () => {
  const browserQaId = "55555555-5555-4555-8555-555555555555";
  const issue = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_review",
    assigneeAgentId: browserQaId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "NSS-452",
    title: "Backend-only billing cleanup",
    executionPolicy: null,
    executionState: null,
  };
  mockIssueService.getById.mockResolvedValue(issue);
  mockAgentService.getById.mockResolvedValue({
    id: browserQaId,
    companyId: "company-1",
    role: "qa",
    name: "QA (Browser)",
    status: "idle",
    permissions: null,
    orgChainHealth: { status: "healthy" },
  });
  mockDbSelectWhere.mockImplementation(() => ({
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve([
        { id: browserQaId, companyId: "company-1", role: "qa", name: "QA (Browser)", status: "idle" },
      ]).then(onFulfilled, onRejected),
  }));

  const res = await request(await createApp({ type: "agent", agentId: browserQaId, companyId: "company-1", runId: "run-1" }))
    .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    .send({ qaVerdict: "pass" });

  expect(res.status).toBe(422);
  expect(res.body.details).toMatchObject({
    code: "invalid_qa_disposition",
    missing: "spec_qa_agent",
  });
  expect(mockIssueService.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Add a regression test for Code QA pass when all downstream QA is missing**

```ts
it("rejects Code QA PASS when no downstream QA agent exists", async () => {
  const codeQaId = "44444444-4444-4444-8444-444444444444";
  const issue = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_review",
    assigneeAgentId: codeQaId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "NSS-452",
    title: "Backend-only billing cleanup",
    executionPolicy: null,
    executionState: null,
  };
  mockIssueService.getById.mockResolvedValue(issue);
  mockAgentService.getById.mockResolvedValue({
    id: codeQaId,
    companyId: "company-1",
    role: "qa",
    name: "QA (Code)",
    status: "idle",
    permissions: null,
    orgChainHealth: { status: "healthy" },
  });
  mockDbSelectWhere.mockImplementation(() => ({
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve([
        { id: codeQaId, companyId: "company-1", role: "qa", name: "QA (Code)", status: "idle" },
      ]).then(onFulfilled, onRejected),
  }));

  const res = await request(await createApp({ type: "agent", agentId: codeQaId, companyId: "company-1", runId: "run-1" }))
    .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    .send({ qaVerdict: "pass" });

  expect(res.status).toBe(422);
  expect(res.body.details).toMatchObject({
    code: "invalid_qa_disposition",
    missing: "downstream_qa_agent",
  });
  expect(mockIssueService.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Replace the non-Spec QA fallback-to-done path**

Inside `if (input.qaVerdict === "pass")`, keep the existing assignment path when `nextQaAgent` exists. Replace the generic fallback:

```ts
input.updateFields.assigneeAgentId = null;
input.updateFields.assigneeUserId = null;
input.updateFields.status = "done";
return;
```

with:

```ts
if (currentStage !== "spec") {
  throw unprocessable("Non-Spec QA pass requires a downstream QA stage before completion", {
    code: "invalid_qa_disposition",
    missing: currentStage === "browser" ? "spec_qa_agent" : "downstream_qa_agent",
  });
}
input.updateFields.assigneeAgentId = null;
input.updateFields.assigneeUserId = null;
input.updateFields.status = "done";
return;
```

This closes the generic hole Claude Sonnet identified: `QA Code` or `QA Browser` must not complete simply because the next-stage QA agent is unavailable.

- [ ] **Step 5: If the direct-done test fails, move the guard earlier**

If direct completion still reaches `svc.update`, ensure `applyDefaultQaDispositionRouting` runs before any logic that can treat a comment as a terminal completion, and ensure it receives the final `updateFields.status`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @paperclipai/server test -- issue-execution-policy-routes
```

Expected: all QA routing tests pass.

---

### Task 4: Update Agent-Facing Contract Text

**Files:**
- Modify: `skills/paperclip/SKILL.md` if the runtime skill text is the source for local agents.
- Modify: `server/src/onboarding-assets/default/AGENTS.md` only if generated agent instructions mirror QA disposition rules.

**Interfaces:**
- Consumes: new `qaBrowserScope` semantics.
- Produces: agents know that backend-only QA Code pass must use `qaVerdict=pass` and `qaBrowserScope=not_applicable`, not `status=done`.

- [ ] **Step 1: Add concise QA disposition wording**

Add wording equivalent to:

```md
QA disposition:

- QA Code PASS for UI/mixed work: PATCH with `qaVerdict: "pass"` and let Paperclip route to QA Browser.
- QA Code PASS for backend-only work: PATCH with `qaVerdict: "pass", qaBrowserScope: "not_applicable"` so Paperclip routes to QA Specs.
- QA Browser PASS: PATCH with `qaVerdict: "pass"` so Paperclip routes to QA Specs.
- QA Specs PASS: PATCH with `qaVerdict: "pass"`; only this stage may close the issue.
- QA FAIL at any stage: PATCH with `qaVerdict: "fail"` and a concrete comment.
```

- [ ] **Step 2: Avoid broad doc rewrites**

Only add this near existing issue update/status guidance. Do not rewrite the whole skill.

---

### Task 5: Verification And Claude Sonnet Validation

**Files:**
- No code files unless validation finds a defect.

**Interfaces:**
- Consumes: local diff and verification output.
- Produces: final confidence gate before handoff.

- [ ] **Step 1: Run targeted verification**

Run:

```bash
pnpm --filter @paperclipai/server test -- issue-execution-policy-routes
```

Expected: PASS.

- [ ] **Step 2: Run relevant typecheck**

Run:

```bash
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/shared typecheck
```

Expected: PASS.

- [ ] **Step 3: Ask Claude Sonnet for read-only validation**

Run:

```bash
timeout 300s zsh -ic 'claude-hr --dangerously-skip-permissions --model sonnet -p "
You are a companion verifier. In repo /home/manu/proyectos/paperclip, inspect the current diff for this requirement:

- QA Code may skip QA Browser only for explicitly backend-only work.
- QA Code backend-only PASS must route to QA Specs, never done.
- QA Browser PASS must route to QA Specs.
- Only QA Specs PASS may complete the issue.
- Direct done from QA Code or QA Browser must be rejected.

Do not modify files. Return concise findings with file:line references, missing tests, and verification commands you recommend.
"'
```

Expected: Claude reports no blocking findings. Treat any Claude finding as advisory; verify locally before changing code.

- [ ] **Step 4: Final local check after any validation fixes**

If Claude identifies a real issue and fixes are made, rerun:

```bash
pnpm --filter @paperclipai/server test -- issue-execution-policy-routes
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/shared typecheck
```

Expected: PASS.

## Self-Review

- Spec coverage: The plan covers backend-only skip, mandatory QA Specs, non-Spec direct completion rejection, missing downstream QA rejection, agent contract text, and independent Claude Sonnet validation.
- Placeholder scan: No `TBD`, `TODO`, or open-ended implementation steps remain.
- Type consistency: The field name is consistently `qaBrowserScope` with values `"required"` and `"not_applicable"`.

## Claude Sonnet Plan Validation

Claude Sonnet reviewed this plan in read-only mode on 2026-07-08. It found one valid blocker: the generic `qaVerdict=pass` fallback could still close `done` for `QA Code` or `QA Browser` when the next QA agent is missing. Task 3 now explicitly tests and fixes that fallback so only `QA Specs` may complete.
