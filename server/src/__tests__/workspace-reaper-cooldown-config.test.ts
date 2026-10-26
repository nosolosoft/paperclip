import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

// The terminal-workspace reaper reads PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS.
// These tests lock the parser contract: the default is 0 days (no cooldown),
// and empty, whitespace-only, negative, or non-numeric values fall back to it.
// Deletion is separately gated by PAPERCLIP_WORKSPACE_REAPER_DELETE_ENABLED,
// which defaults to false.

describe("workspace reaper cooldown config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the 0 day default when the variable is not set", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", undefined);
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("uses the 0 day default for an empty value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("uses the 0 day default for a whitespace-only value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "   ");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("keeps an explicit 0", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "0");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("reads a positive whole number", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "14");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(14);
  });

  it("trims surrounding whitespace before it reads the number", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "  3  ");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(3);
  });

  it("uses the 0 day default for a negative value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "-1");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("uses the 0 day default for a non-numeric value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "soon");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });
});

describe("workspace reaper delete flag config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to false when the variable is not set", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_DELETE_ENABLED", undefined);
    expect(loadConfig().workspaceReaperDeleteEnabled).toBe(false);
  });

  it("is true only for the literal true value, trimmed and case-insensitive", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_DELETE_ENABLED", " TRUE ");
    expect(loadConfig().workspaceReaperDeleteEnabled).toBe(true);
  });

  it("stays false for other values", () => {
    for (const value of ["", "false", "1", "yes"]) {
      vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_DELETE_ENABLED", value);
      expect(loadConfig().workspaceReaperDeleteEnabled).toBe(false);
    }
  });
});
