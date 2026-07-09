import { describe, expect, it } from "vitest";

import {
  normalizeRepositoryIdentityForWorkspaceSelection,
  resolveProjectWorkspacePreferenceForPrimaryWorkProductRepo,
} from "../services/heartbeat.ts";

describe("primary work product repository workspace selection", () => {
  it("selects the unique project workspace matching the primary PR repository", () => {
    const selection = resolveProjectWorkspacePreferenceForPrimaryWorkProductRepo({
      primaryWorkProductMetadata: {
        repository: "https://github.com/acme/opptests-web-frontend.git",
      },
      projectWorkspaces: [
        {
          id: "backend-workspace",
          repoUrl: "https://github.com/acme/opptests-backend.git",
        },
        {
          id: "frontend-workspace",
          repoUrl: "git@github.com:acme/opptests-web-frontend.git",
        },
      ],
      preferredWorkspaceId: "backend-workspace",
      preferredWorkspaceSource: "issue_workspace",
    });

    expect(selection).toMatchObject({
      preferredWorkspaceId: "frontend-workspace",
      source: "pr_matched_workspace",
      expectedRepository: "github.com/acme/opptests-web-frontend",
      actualRepository: "github.com/acme/opptests-web-frontend",
      error: null,
    });
  });

  it("respects an explicit issue workspace when it already matches the PR repository", () => {
    const selection = resolveProjectWorkspacePreferenceForPrimaryWorkProductRepo({
      primaryWorkProductMetadata: {
        repository: { fullName: "acme/opptests-web-frontend" },
      },
      projectWorkspaces: [
        {
          id: "backend-workspace",
          repoUrl: "https://github.com/acme/opptests-backend.git",
        },
        {
          id: "frontend-workspace",
          repoUrl: "https://github.com/acme/opptests-web-frontend",
        },
      ],
      preferredWorkspaceId: "frontend-workspace",
      preferredWorkspaceSource: "issue_workspace",
    });

    expect(selection).toMatchObject({
      preferredWorkspaceId: "frontend-workspace",
      source: "issue_workspace",
      expectedRepository: "github.com/acme/opptests-web-frontend",
      actualRepository: "github.com/acme/opptests-web-frontend",
      error: null,
    });
  });

  it("fails before falling back to the project primary when the PR repo has no matching workspace", () => {
    const selection = resolveProjectWorkspacePreferenceForPrimaryWorkProductRepo({
      primaryWorkProductMetadata: {
        repository: "acme/opptests-web-frontend",
      },
      projectWorkspaces: [
        {
          id: "backend-workspace",
          repoUrl: "https://github.com/acme/opptests-backend.git",
        },
      ],
      preferredWorkspaceId: "backend-workspace",
      preferredWorkspaceSource: "project_primary",
    });

    expect(selection).toMatchObject({
      preferredWorkspaceId: "backend-workspace",
      source: "project_primary",
      expectedRepository: "github.com/acme/opptests-web-frontend",
      actualRepository: "github.com/acme/opptests-backend",
      error: {
        code: "primary_work_product_repository_mismatch",
        message: "PR repo does not match issue workspace",
      },
    });
  });

  it("normalizes common GitHub repository URL forms", () => {
    expect(normalizeRepositoryIdentityForWorkspaceSelection("git@github.com:Acme/OppTests-Web-Frontend.git")).toBe(
      "github.com/acme/opptests-web-frontend",
    );
    expect(
      normalizeRepositoryIdentityForWorkspaceSelection("https://github.com/acme/opptests-web-frontend/pull/42"),
    ).toBe("github.com/acme/opptests-web-frontend");
  });
});
