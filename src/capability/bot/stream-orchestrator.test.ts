import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBotStreamOrchestrator } from "./stream-orchestrator.js";
import { processBotInboundMessage } from "../../transport/bot-webhook/inbound-normalizer.js";
import { buildDynamicAgentInboundBody, ensureDynamicAgentListed } from "../../dynamic-agent.js";
import { buildWecomBotDispatchConfig } from "./dispatch-config.js";
import { finalizeBotStream } from "./stream-finalizer.js";
import { handleDirectLocalPathIntent } from "./local-path-delivery.js";
import { createBotReplyDispatcher } from "./stream-delivery.js";

vi.mock("../../transport/bot-webhook/inbound-normalizer.js", () => ({
  looksLikeSendLocalFileIntent: vi.fn().mockReturnValue(false),
  processBotInboundMessage: vi.fn(),
}));

vi.mock("../../dynamic-agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../dynamic-agent.js")>(
    "../../dynamic-agent.js",
  );
  return {
    ...actual,
    buildDynamicAgentInboundBody: vi.fn(),
    ensureDynamicAgentListed: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./dispatch-config.js", () => ({
  buildWecomBotDispatchConfig: vi.fn((cfg) => cfg),
}));

vi.mock("./stream-finalizer.js", () => ({
  finalizeBotStream: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./local-path-delivery.js", () => ({
  handleDirectLocalPathIntent: vi.fn().mockResolvedValue(false),
}));

vi.mock("./stream-delivery.js", () => ({
  createBotReplyDispatcher: vi.fn().mockReturnValue({ deliver: vi.fn() }),
}));

vi.mock("./fallback-delivery.js", () => ({
  sendBotFallbackPromptNow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./sandbox-media.js", () => ({
  stageWecomInboundMediaForSession: vi.fn(),
}));

describe("createBotStreamOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processBotInboundMessage).mockResolvedValue({
      body: "/reset",
      media: undefined,
    });
    vi.mocked(buildDynamicAgentInboundBody).mockReturnValue({
      commandBody: "/reset",
      modelInputBody: "[Runtime note: workspace skills changed]\n\n/reset",
    });
    vi.mocked(handleDirectLocalPathIntent).mockResolvedValue(false);
    vi.mocked(buildWecomBotDispatchConfig).mockImplementation((cfg) => cfg);
    vi.mocked(createBotReplyDispatcher).mockReturnValue({ deliver: vi.fn() });
  });

  it("keeps CommandBody on the original slash command while only Body gets the runtime note", async () => {
    const formatAgentEnvelope = vi.fn(({ body }) => `formatted:${body}`);
    const finalizeInboundContext = vi.fn((ctx) => ctx);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue(undefined);
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const core = {
      logging: {
        shouldLogVerbose: () => false,
      },
      channel: {
        media: {
          saveMediaBuffer: vi.fn(),
        },
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            agentId: "main",
            accountId: "acct-1",
            sessionKey: "agent:main",
            matchedBy: "binding.account",
          }),
        },
        reply: {
          formatAgentEnvelope,
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher,
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/store"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession,
        },
        text: {
          resolveMarkdownTableMode: vi.fn().mockReturnValue("plain"),
        },
        commands: {
          shouldComputeCommandAuthorized: vi.fn((text: string) => text.trim().startsWith("/")),
          resolveCommandAuthorizedFromAuthorizers: vi.fn().mockReturnValue(true),
        },
      },
    } as any;
    const streamStore = {
      updateStream: vi.fn(),
      onStreamFinished: vi.fn(),
    } as any;
    const orchestrator = createBotStreamOrchestrator({
      streamStore,
      recordBotOperationalEvent: vi.fn(),
    });

    await orchestrator.startAgentForStream({
      streamId: "stream-1",
      msg: {
        msgid: "msg-1",
        chattype: "single",
        from: { userid: "alice" },
      } as any,
      target: {
        core,
        config: {},
        account: {
          accountId: "acct-1",
          config: {},
        },
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      accountId: "acct-1",
    });

    expect(buildDynamicAgentInboundBody).toHaveBeenCalledWith({
      agentId: "main",
      commandBody: "/reset",
      isCommand: true,
    });
    expect(formatAgentEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      body: "[Runtime note: workspace skills changed]\n\n/reset",
    }));
    expect(finalizeInboundContext).toHaveBeenCalledWith(expect.objectContaining({
      RawBody: "/reset",
      CommandBody: "/reset",
    }));
    expect(vi.mocked(finalizeBotStream)).toHaveBeenCalledWith(expect.objectContaining({
      isResetCommand: true,
      resetCommandKind: "reset",
    }));
    expect(vi.mocked(ensureDynamicAgentListed)).not.toHaveBeenCalled();
  });
});
