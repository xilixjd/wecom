/**
 * **动态 Agent 路由模块**
 *
 * 为每个用户/群组自动生成独立的 Agent ID，实现会话隔离。
 * 参考: openclaw-plugin-wecom/dynamic-agent.js
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";


import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DynamicAgentConfig {
    enabled: boolean;
    dmCreateAgent: boolean;
    groupEnabled: boolean;
    adminUsers: string[];
    workspaceSeed?: boolean;
}

/**
 * **getDynamicAgentConfig (读取动态 Agent 配置)**
 *
 * 从全局配置中读取动态 Agent 配置，提供默认值。
 */
export function getDynamicAgentConfig(config: OpenClawConfig): DynamicAgentConfig {
    const dynamicAgents = (config as { channels?: { wecom?: { dynamicAgents?: Partial<DynamicAgentConfig> } } })?.channels?.wecom?.dynamicAgents;
    return {
        enabled: dynamicAgents?.enabled ?? false,
        dmCreateAgent: dynamicAgents?.dmCreateAgent ?? true,
        groupEnabled: dynamicAgents?.groupEnabled ?? true,
        adminUsers: dynamicAgents?.adminUsers ?? [],
        workspaceSeed: dynamicAgents?.workspaceSeed ?? false,
    };
}

function sanitizeDynamicIdPart(value: string): string {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_");
}

/**
 * **generateAgentId (生成动态 Agent ID)**
 *
 * 根据账号 + 聊天类型 + 对端 ID 生成确定性的 Agent ID，避免多账号串会话。
 * 格式: wecom-{accountId}-{type}-{sanitizedPeerId}
 */
export function generateAgentId(chatType: "dm" | "group", peerId: string, accountId?: string): string {
    const sanitizedPeer = sanitizeDynamicIdPart(peerId) || "unknown";
    const sanitizedAccountId = sanitizeDynamicIdPart(accountId ?? "default") || "default";
    return `wecom-${sanitizedAccountId}-${chatType}-${sanitizedPeer}`;
}

export function buildAgentSessionTarget(userId: string, accountId?: string): string {
    const normalizedUserId = String(userId).trim();
    const sanitizedAccountId = sanitizeDynamicIdPart(accountId ?? "default") || "default";
    // Always use explicit user: prefix to avoid ambiguity with numeric party IDs
    return `wecom-agent:${sanitizedAccountId}:user:${normalizedUserId}`;
}

/**
 * **shouldUseDynamicAgent (检查是否使用动态 Agent)**
 *
 * 根据配置和发送者信息判断是否应使用动态 Agent。
 * 管理员（adminUsers）始终绕过动态路由，使用主 Agent。
 */
export function shouldUseDynamicAgent(params: {
    chatType: "dm" | "group";
    senderId: string;
    config: OpenClawConfig;
}): boolean {
    const { chatType, senderId, config } = params;
    const dynamicConfig = getDynamicAgentConfig(config);

    if (!dynamicConfig.enabled) {
        return false;
    }

    // 管理员绕过动态路由
    const sender = String(senderId).trim().toLowerCase();
    const isAdmin = dynamicConfig.adminUsers.some(
        (admin) => admin.trim().toLowerCase() === sender
    );
    if (isAdmin) {
        return false;
    }

    if (chatType === "group") {
        return dynamicConfig.groupEnabled;
    }
    return dynamicConfig.dmCreateAgent;
}

/**
 * 内存中已确保的 Agent ID（避免重复写入）
 */
const ensuredDynamicAgentIds = new Set<string>();

/**
 * 写入队列（避免并发冲突）
 */
let ensureDynamicAgentWriteQueue: Promise<void> = Promise.resolve();

/**
 * 将 Agent ID 插入 agents.list（如果不存在）
 */
function upsertAgentIdOnlyEntry(cfg: Record<string, unknown>, agentId: string): boolean {
    if (!cfg.agents || typeof cfg.agents !== "object") {
        cfg.agents = {};
    }

    const agentsObj = cfg.agents as Record<string, unknown>;
    const currentList: Array<{ id: string }> = Array.isArray(agentsObj.list) ? agentsObj.list as Array<{ id: string }> : [];
    const existingIds = new Set(
        currentList
            .map((entry) => entry?.id?.trim().toLowerCase())
            .filter((id): id is string => Boolean(id))
    );

    let changed = false;
    const nextList = [...currentList];

    // 首次创建时保留 main 作为默认
    if (nextList.length === 0) {
        nextList.push({ id: "main" });
        existingIds.add("main");
        changed = true;
    }

    if (!existingIds.has(agentId.toLowerCase())) {
        nextList.push({ id: agentId });
        changed = true;
    }

    if (changed) {
        agentsObj.list = nextList;
    }

    return changed;
}

/**
 * **ensureDynamicAgentListed (确保动态 Agent 已添加到 agents.list)**
 *
 * 将动态生成的 Agent ID 添加到 OpenClaw 配置中的 agents.list。
 * 特性：
 * - 幂等：使用内存 Set 避免重复写入
 * - 串行：使用 Promise 队列避免并发冲突
 * - 异步：不阻塞消息处理流程
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureDynamicAgentListed(agentId: string, runtime: any): Promise<void> {
    const normalizedId = String(agentId).trim().toLowerCase();
    if (!normalizedId) return;
    if (ensuredDynamicAgentIds.has(normalizedId)) return;

    const configRuntime = runtime?.config;
    if (!configRuntime?.loadConfig || !configRuntime?.writeConfigFile) return;

    ensureDynamicAgentWriteQueue = ensureDynamicAgentWriteQueue
        .then(async () => {
            if (ensuredDynamicAgentIds.has(normalizedId)) return;

            const latestConfig = configRuntime.loadConfig!();
            if (!latestConfig || typeof latestConfig !== "object") return;

            const changed = upsertAgentIdOnlyEntry(latestConfig as Record<string, unknown>, normalizedId);
            if (changed) {
                await configRuntime.writeConfigFile!(latestConfig as unknown);
            }

            ensuredDynamicAgentIds.add(normalizedId);
        })
        .catch((err) => {
            console.warn(`[wecom] 动态 Agent 添加失败: ${normalizedId}`, err);
        });

    await ensureDynamicAgentWriteQueue;
}

/**
 * **resetEnsuredCache (重置已确保缓存)**
 *
 * 主要用于测试场景，重置内存中的缓存状态。
 */
export function resetEnsuredCache(): void {
    ensuredDynamicAgentIds.clear();

    for (const watcher of dynamicSkillsRootWatchers.values()) {
        watcher.close();
    }
    dynamicSkillsRootWatchers.clear();

    for (const childWatchers of dynamicSkillsChildWatchers.values()) {
        for (const watcher of childWatchers.values()) {
            watcher.close();
        }
    }
    dynamicSkillsChildWatchers.clear();
    dynamicSkillsWorkspaceDirs.clear();
    dynamicSkillsDeltaState.clear();
}

/**
 * 已 seed 的动态 workspace 缓存
 */
const dynamicSkillsRootWatchers = new Map<string, fs.FSWatcher>();
const dynamicSkillsChildWatchers = new Map<string, Map<string, fs.FSWatcher>>();
const dynamicSkillsWorkspaceDirs = new Map<string, string>();

type DynamicSkillDelta = {
    skillName: string;
    changeType: "added" | "updated" | "removed";
    skillFilePath: string;
};

type DynamicSkillsDeltaState = {
    changes: Map<string, DynamicSkillDelta>;
};

const dynamicSkillsDeltaState = new Map<string, DynamicSkillsDeltaState>();

const DYNAMIC_WORKSPACE_STANDARD_FILES = [
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
];

/**
 * 获取 OpenClaw 状态目录
 */
function resolveStateDir(): string {
    const stateOverride = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
    if (stateOverride) {
        return stateOverride;
    }
    return path.join(os.homedir(), ".openclaw");
}

function recordDynamicSkillDelta(
    agentId: string,
    skillName: string,
    changeType: "added" | "updated" | "removed",
    skillFilePath: string,
): void {
    const existing = dynamicSkillsDeltaState.get(agentId) ?? {
        changes: new Map<string, DynamicSkillDelta>(),
    };
    existing.changes.set(skillName, { skillName, changeType, skillFilePath });
    dynamicSkillsDeltaState.set(agentId, existing);
}

function noteDynamicSkillFileChange(agentId: string, skillDir: string): void {
    const skillName = path.basename(skillDir);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const exists = fs.existsSync(skillFilePath);
    recordDynamicSkillDelta(
        agentId,
        skillName,
        exists ? "updated" : "removed",
        skillFilePath,
    );
}

export function consumeDynamicSkillsDeltaNote(agentId: string): string | undefined {
    const state = dynamicSkillsDeltaState.get(agentId);
    if (!state || state.changes.size === 0) {
        return undefined;
    }

    const lines = [
        "[Runtime note: workspace skills changed]",
        "The following workspace skills changed recently. Any earlier conversation about them may be stale.",
    ];

    for (const change of state.changes.values()) {
        lines.push(`- ${change.changeType}: ${change.skillName} (${change.skillFilePath})`);
    }

    lines.push("If the current task may use one of these skills, re-read the listed SKILL.md before relying on it.");

    dynamicSkillsDeltaState.delete(agentId);

    return lines.join("\n");
}

export function buildDynamicAgentInboundBody(params: {
    agentId: string;
    commandBody: string;
    isCommand: boolean;
}): {
    commandBody: string;
    modelInputBody: string;
} {
    const { agentId, commandBody, isCommand } = params;
    if (isCommand) {
        return {
            commandBody,
            modelInputBody: commandBody,
        };
    }

    const skillsDeltaNote = consumeDynamicSkillsDeltaNote(agentId);
    if (!skillsDeltaNote) {
        return {
            commandBody,
            modelInputBody: commandBody,
        };
    }

    return {
        commandBody,
        modelInputBody: [skillsDeltaNote, "", commandBody].join("\n"),
    };
}

function watchSkillChildDir(agentId: string, childDir: string): void {
    let watchers = dynamicSkillsChildWatchers.get(agentId);
    if (!watchers) {
        watchers = new Map<string, fs.FSWatcher>();
        dynamicSkillsChildWatchers.set(agentId, watchers);
    }
    if (watchers.has(childDir) || !fs.existsSync(childDir)) {
        return;
    }

    try {
        const watcher = fs.watch(childDir, (_eventType, fileName) => {
            if (!fileName || String(fileName) === "SKILL.md") {
                noteDynamicSkillFileChange(agentId, childDir);
            }
        });
        watcher.on("error", (err) => {
            console.error(`[wecom-skills-watch] child watcher error for ${agentId}: ${err}`);
        });
        watchers.set(childDir, watcher);
    } catch (err) {
        console.error(`[wecom-skills-watch] failed to watch ${childDir}: ${err}`);
    }
}

function syncDynamicSkillsChildWatchers(agentId: string, skillsDir: string, includeAdds: boolean): void {
    const active = dynamicSkillsChildWatchers.get(agentId) ?? new Map<string, fs.FSWatcher>();
    const nextDirs = new Set<string>();

    if (fs.existsSync(skillsDir)) {
        try {
            const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const childDir = path.join(skillsDir, entry.name);
                nextDirs.add(childDir);
                if (!active.has(childDir)) {
                    watchSkillChildDir(agentId, childDir);
                    const skillFilePath = path.join(childDir, "SKILL.md");
                    if (includeAdds && fs.existsSync(skillFilePath)) {
                        recordDynamicSkillDelta(agentId, entry.name, "added", skillFilePath);
                    }
                }
            }
        } catch (err) {
            console.error(`[wecom-skills-watch] failed to scan ${skillsDir}: ${err}`);
        }
    }

    for (const [childDir, watcher] of active) {
        if (nextDirs.has(childDir)) {
            continue;
        }
        watcher.close();
        active.delete(childDir);
        recordDynamicSkillDelta(agentId, path.basename(childDir), "removed", path.join(childDir, "SKILL.md"));
    }

    dynamicSkillsChildWatchers.set(agentId, active);
}

function ensureDynamicSkillsWatcher(agentId: string, workspaceDir: string): void {
    const normalizedWorkspaceDir = path.resolve(workspaceDir);
    const existingWorkspaceDir = dynamicSkillsWorkspaceDirs.get(agentId);
    if (existingWorkspaceDir && existingWorkspaceDir !== normalizedWorkspaceDir) {
        dynamicSkillsRootWatchers.get(agentId)?.close();
        dynamicSkillsRootWatchers.delete(agentId);

        const childWatchers = dynamicSkillsChildWatchers.get(agentId);
        if (childWatchers) {
            for (const watcher of childWatchers.values()) {
                watcher.close();
            }
            dynamicSkillsChildWatchers.delete(agentId);
        }
    }

    dynamicSkillsWorkspaceDirs.set(agentId, normalizedWorkspaceDir);

    const skillsDir = path.join(normalizedWorkspaceDir, "skills");
    if (!fs.existsSync(skillsDir)) {
        return;
    }

    if (!dynamicSkillsRootWatchers.has(agentId)) {
        try {
            const watcher = fs.watch(skillsDir, (_eventType, fileName) => {
                syncDynamicSkillsChildWatchers(agentId, skillsDir, true);
                if (!fileName || String(fileName) === "SKILL.md") {
                    recordDynamicSkillDelta(agentId, "(workspace-root)", "updated", path.join(skillsDir, "SKILL.md"));
                }
            });
            watcher.on("error", (err) => {
                console.error(`[wecom-skills-watch] root watcher error for ${agentId}: ${err}`);
            });
            dynamicSkillsRootWatchers.set(agentId, watcher);
        } catch (err) {
            console.error(`[wecom-skills-watch] failed to watch ${skillsDir}: ${err}`);
            return;
        }
    }

    syncDynamicSkillsChildWatchers(agentId, skillsDir, false);
}

/**
 * **ensureDynamicWorkspaceSeeded (确保动态 Agent workspace 已初始化)**
 *
 * 在动态 agent 首次使用前，将基础 workspace 的内容复制到动态 workspace。
 */
export function ensureDynamicWorkspaceSeeded(params: {
    dynamicAgentId: string;
    sourceAgentId: string;
    config?: OpenClawConfig;
}): void {
    const { dynamicAgentId, sourceAgentId, config } = params;

    const stateDir = resolveStateDir();
    const targetWorkspace = path.join(stateDir, `workspace-${dynamicAgentId}`);
    const seedMarker = path.join(targetWorkspace, ".seeded");

    // 如果已经 seed 过，跳过
    if (fs.existsSync(seedMarker)) {
        ensureDynamicSkillsWatcher(dynamicAgentId, targetWorkspace);
        return;
    }

    // 查找可用的 workspace（按优先级）
    const candidates: string[] = [];

    // 1. 从 agents.list 中查找 sourceAgentId 对应的 workspace 字段
    if (config) {
        const agentsList = (config as any)?.agents?.list;
        if (Array.isArray(agentsList)) {
            for (const agent of agentsList) {
                if (typeof agent === 'object' && agent?.id === sourceAgentId && agent.workspace) {
                    const workspacePath = String(agent.workspace).replace(/^~/, os.homedir());
                    candidates.push(path.resolve(workspacePath));
                    break;
                }
            }
        }
    }

    // 2. 如果 list 中没找到或没有 workspace 字段，使用默认路径
    if (candidates.length === 0) {
        candidates.push(path.join(stateDir, `workspace-${sourceAgentId}`));
    }

    // 3. 最后回退到默认 workspace
    candidates.push(path.join(stateDir, 'workspace'));

    // 查找第一个存在的 workspace
    let sourceWorkspace: string | undefined;
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            sourceWorkspace = candidate;
            break;
        }
    }

    if (!sourceWorkspace) {
        return;
    }

    // 创建目标目录
    try {
        fs.mkdirSync(targetWorkspace, { recursive: true });
    } catch (err) {
        console.error(`[wecom-workspace-seed] failed to create target workspace: ${err}`);
        return;
    }

    let seedFailed = false;

    // 复制标准 .md 文件
    for (const file of DYNAMIC_WORKSPACE_STANDARD_FILES) {
        const src = path.join(sourceWorkspace, file);
        const dest = path.join(targetWorkspace, file);
        if (fs.existsSync(src)) {
            try {
                fs.copyFileSync(src, dest);
            } catch (err) {
                seedFailed = true;
                console.error(`[wecom-workspace-seed] failed to copy ${file}: ${err}`);
            }
        }
    }

    // 复制 skills/ 目录
    const skillsDir = path.join(sourceWorkspace, "skills");
    if (fs.existsSync(skillsDir)) {
        const targetSkillsDir = path.join(targetWorkspace, "skills");
        try {
            fs.mkdirSync(targetSkillsDir, { recursive: true });
            seedFailed = copyDirRecursive(skillsDir, targetSkillsDir) || seedFailed;
        } catch (err) {
            seedFailed = true;
            console.error(`[wecom-workspace-seed] failed to copy skills: ${err}`);
        }
    }

    if (seedFailed) {
        return;
    }

    // 写入 seed 标记
    try {
        fs.writeFileSync(seedMarker, new Date().toISOString());
        ensureDynamicSkillsWatcher(dynamicAgentId, targetWorkspace);
    } catch (err) {
        console.error(`[wecom-workspace-seed] failed to write seed marker: ${err}`);
    }
}

/**
 * 递归复制目录
 */
function copyDirRecursive(src: string, dest: string): boolean {
    let hadError = false;
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        try {
            if (entry.isDirectory()) {
                fs.mkdirSync(destPath, { recursive: true });
                hadError = copyDirRecursive(srcPath, destPath) || hadError;
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        } catch (err) {
            hadError = true;
            console.error(`[wecom-workspace-seed] failed to copy ${entry.name}: ${err}`);
        }
    }
    return hadError;
}

export function resetWorkspaceCache(): void {
    for (const watcher of dynamicSkillsRootWatchers.values()) {
        watcher.close();
    }
    dynamicSkillsRootWatchers.clear();
    for (const childWatchers of dynamicSkillsChildWatchers.values()) {
        for (const watcher of childWatchers.values()) {
            watcher.close();
        }
    }
    dynamicSkillsChildWatchers.clear();
    dynamicSkillsWorkspaceDirs.clear();
    dynamicSkillsDeltaState.clear();
}
