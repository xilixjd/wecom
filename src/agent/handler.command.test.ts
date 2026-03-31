import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAgentWebhook } from "./handler.js";
import { buildDynamicAgentInboundBody } from "../dynamic-agent.js";
import { sendAgentApiText } from "../transport/agent-api/client.js";

vi.mock("../dynamic-agent.js", async () => {
  const actual = await vi.importActual<typeof import("../dynamic-agent.js")>(
    "../dynamic-agent.js",
  );
  return {
    ...actual,
    buildDynamicAgentInboundBody: vi.fn(),
    ensureDynamicAgentListed: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../transport/agent-api/client.js", () => ({
  downloadAgentApiMedia: vi.fn(),
  sendAgentApiText: vi.fn().mockResolvedValue(undefined),
}));

describe("handleAgentWebhook command bodies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildDynamicAgentInboundBody).mockReturnValue({
      commandBody: "/btw",
      modelInputBody: "[Runtime note: workspace skills changed]\n\n/btw",
    });
  });

  it("keeps slash commands intact in RawBody and CommandBody for agent callbacks", async () => {
    const formatAgentEnvelope = vi.fn(({ body }) => `formatted:${body}`);
    const finalizeInboundContext = vi.fn((ctx) => ctx);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue(undefined);
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const req = {
      method: "POST",
      url: "/agent",
      socket: { remoteAddress: "127.0.0.1" },
    } as any;
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as any;
    const core = {
      channel: {
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
        commands: {
          shouldComputeCommandAuthorized: vi.fn((text: string) => text.trim().startsWith("/")),
          resolveCommandAuthorizedFromAuthorizers: vi.fn().mockReturnValue(true),
        },
      },
    } as any;

    await handleAgentWebhook({
      req,
      res,
      verifiedPost: {
        timestamp: "1",
        nonce: "n-1",
        signature: "sig-1",
        encrypted: "encrypted",
        decrypted: "<xml />",
        parsed: {
          MsgType: "text",
          FromUserName: "alice",
          Content: "/btw",
          MsgId: "msg-agent-1",
        } as any,
      },
      agent: {
        accountId: "acct-1",
        agentId: 1,
        config: {},
      } as any,
      config: {},
      core,
      log: vi.fn(),
      error: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    });

    expect(buildDynamicAgentInboundBody).toHaveBeenCalledWith({
      agentId: "main",
      commandBody: "/btw",
      isCommand: true,
    });
    expect(formatAgentEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      body: "[Runtime note: workspace skills changed]\n\n/btw",
    }));
    expect(finalizeInboundContext).toHaveBeenCalledWith(expect.objectContaining({
      RawBody: "/btw",
      CommandBody: "/btw",
    }));
    expect(vi.mocked(sendAgentApiText)).not.toHaveBeenCalled();
  });
});
