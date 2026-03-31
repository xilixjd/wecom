import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDynamicAgentInboundBody,
  ensureDynamicWorkspaceSeeded,
  resetEnsuredCache,
  resetWorkspaceCache,
} from "./dynamic-agent.js";

describe("ensureDynamicWorkspaceSeeded", () => {
  const root = path.join("/tmp", `wecom-dynamic-seed-${process.pid}`);

  afterEach(async () => {
    resetEnsuredCache();
    resetWorkspaceCache();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("does not reseed an already marked workspace when the target has no skills directory", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);

    const sourceWorkspace = path.join(root, "workspace-main");
    const targetWorkspace = path.join(root, "workspace-dyn-user");
    await mkdir(sourceWorkspace, { recursive: true });
    await writeFile(path.join(sourceWorkspace, "AGENTS.md"), "source agents");

    ensureDynamicWorkspaceSeeded({
      dynamicAgentId: "dyn-user",
      sourceAgentId: "main",
    });

    await writeFile(path.join(targetWorkspace, "AGENTS.md"), "agent edited");

    ensureDynamicWorkspaceSeeded({
      dynamicAgentId: "dyn-user",
      sourceAgentId: "main",
    });

    await expect(readFile(path.join(targetWorkspace, "AGENTS.md"), "utf8")).resolves.toBe("agent edited");
    await expect(readFile(path.join(targetWorkspace, ".seeded"), "utf8")).resolves.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps a pending skills runtime note for the next non-command message", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);

    const sourceWorkspace = path.join(root, "workspace-main");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "example-skill");
    await mkdir(sourceSkillDir, { recursive: true });
    await writeFile(path.join(sourceWorkspace, "AGENTS.md"), "source agents");
    await writeFile(path.join(sourceSkillDir, "SKILL.md"), "version 1");

    ensureDynamicWorkspaceSeeded({
      dynamicAgentId: "dyn-skill-user",
      sourceAgentId: "main",
    });

    const targetSkillFile = path.join(
      root,
      "workspace-dyn-skill-user",
      "skills",
      "example-skill",
      "SKILL.md",
    );
    await writeFile(targetSkillFile, "version 2");

    const commandResult = buildDynamicAgentInboundBody({
      agentId: "dyn-skill-user",
      commandBody: "/reset",
      isCommand: true,
    });
    expect(commandResult.modelInputBody).toBe("/reset");

    await vi.waitFor(() => {
      const normalResult = buildDynamicAgentInboundBody({
        agentId: "dyn-skill-user",
        commandBody: "hello",
        isCommand: false,
      });
      expect(normalResult.modelInputBody).toContain("[Runtime note: workspace skills changed]");
      expect(normalResult.modelInputBody).toContain("example-skill");
      expect(normalResult.modelInputBody).toContain("hello");
    });
  });
});
