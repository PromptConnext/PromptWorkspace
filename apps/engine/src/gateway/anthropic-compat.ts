// Anthropic Messages API façade over the BYO gateway (ADR 0006, the
// free-claude-code pattern with the proxy folded into our engine): an agent
// CLI that speaks the Anthropic protocol (Claude Code via ANTHROPIC_BASE_URL)
// talks to this endpoint, and we forward to whatever OpenAI-compatible model
// the team connected for the `code` role. Localhost only, like everything
// else in the engine.
import { Hono } from "hono";
import { readSecret } from "../keychain.ts";
import type { ModelConnection } from "./index.ts";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContentBlock[] };

type AnthropicRequest = {
  model?: string;
  system?: string | { type: string; text?: string }[];
  messages?: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
  tool_choice?: { type: string; name?: string };
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
};

type OpenAIMessage = {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

// Anthropic message list -> OpenAI chat messages. Mixed user turns (tool
// results + text) become tool messages followed by a user message.
export function toOpenAIMessages(req: AnthropicRequest): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const system = blockText(req.system ?? "");
  if (system) out.push({ role: "system", content: system });

  for (const msg of req.messages ?? []) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      let text = "";
      const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
      for (const block of msg.content) {
        if (block.type === "text") text += (block as { text: string }).text;
        else if (block.type === "tool_use") {
          const b = block as { id: string; name: string; input: unknown };
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      let text = "";
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const b = block as { tool_use_id: string; content?: unknown };
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: blockText(b.content) || "(no output)" });
        } else if (block.type === "text") {
          text += (block as { text: string }).text;
        }
      }
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

function toOpenAIBody(req: AnthropicRequest, model: string, stream: boolean) {
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(req),
    stream,
  };
  if (req.max_tokens) body.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? {} },
    }));
  }
  if (req.tool_choice) {
    body.tool_choice =
      req.tool_choice.type === "tool"
        ? { type: "function", function: { name: req.tool_choice.name } }
        : req.tool_choice.type === "any"
          ? "required"
          : "auto";
  }
  return body;
}

function stopReason(finish: string | undefined): string {
  if (finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
}

// Ollama ships an OpenAI-compatible API under /v1 — use it so tool calls work
// the same everywhere.
function chatCompletionsURL(conn: ModelConnection): string {
  const base = conn.endpoint.replace(/\/$/, "");
  return conn.provider === "ollama" ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
}

async function upstream(conn: ModelConnection, body: unknown): Promise<Response> {
  const key = conn.credential_ref ? readSecret(conn.credential_ref) : null;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  return fetch(chatCompletionsURL(conn), { method: "POST", headers, body: JSON.stringify(body) });
}

export function anthropicCompat(getConnection: () => ModelConnection | undefined): Hono {
  const app = new Hono();

  app.post("/v1/messages/count_tokens", async (c) => {
    const req = (await c.req.json()) as AnthropicRequest;
    const chars = JSON.stringify(req.messages ?? []).length + blockText(req.system ?? "").length;
    return c.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)) });
  });

  app.get("/v1/models", (c) => {
    const conn = getConnection();
    return c.json({
      data: conn ? [{ id: conn.model, type: "model", display_name: `${conn.provider}/${conn.model}` }] : [],
    });
  });

  app.post("/v1/messages", async (c) => {
    const conn = getConnection();
    if (!conn) {
      return c.json({ type: "error", error: { type: "invalid_request_error", message: "no verified coding model connected" } }, 400);
    }
    const req = (await c.req.json()) as AnthropicRequest;
    const msgId = `msg_pz_${Date.now().toString(36)}`;

    if (!req.stream) {
      const res = await upstream(conn, toOpenAIBody(req, conn.model, false));
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        return c.json({ type: "error", error: { type: "api_error", message: `upstream ${res.status}: ${detail}` } }, 502);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      const content: AnthropicContentBlock[] = [];
      if (choice?.message?.content) content.push({ type: "text", text: choice.message.content });
      for (const call of choice?.message?.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = { _raw: call.function.arguments };
        }
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      return c.json({
        id: msgId,
        type: "message",
        role: "assistant",
        model: conn.model,
        content,
        stop_reason: stopReason(choice?.finish_reason),
        stop_sequence: null,
        usage: {
          input_tokens: data.usage?.prompt_tokens ?? 0,
          output_tokens: data.usage?.completion_tokens ?? 0,
        },
      });
    }

    // Streaming: translate OpenAI chunk deltas into Anthropic SSE events.
    const res = await upstream(conn, toOpenAIBody(req, conn.model, true));
    if (!res.ok || !res.body) {
      const detail = (await res.text()).slice(0, 300);
      return c.json({ type: "error", error: { type: "api_error", message: `upstream ${res.status}: ${detail}` } }, 502);
    }
    const upstreamBody = res.body;

    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const emit = (event: string, data: unknown) =>
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

        emit("message_start", {
          type: "message_start",
          message: {
            id: msgId, type: "message", role: "assistant", model: conn.model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        let blockIndex = -1;
        let openBlock: "none" | "text" | "tool" = "none";
        let finish: string | undefined;
        let outputTokens = 0;

        const closeBlock = () => {
          if (openBlock !== "none") {
            emit("content_block_stop", { type: "content_block_stop", index: blockIndex });
            openBlock = "none";
          }
        };

        const decoder = new TextDecoder();
        let buf = "";
        try {
          for await (const chunk of upstreamBody) {
            buf += decoder.decode(chunk, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).replace(/\r$/, "");
              buf = buf.slice(nl + 1);
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") continue;
              let parsed: {
                choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
                usage?: { completion_tokens?: number };
              };
              try {
                parsed = JSON.parse(data);
              } catch {
                continue;
              }
              if (parsed.usage?.completion_tokens) outputTokens = parsed.usage.completion_tokens;
              const choice = parsed.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) finish = choice.finish_reason;

              const delta = choice.delta ?? {};
              if (delta.content) {
                if (openBlock !== "text") {
                  closeBlock();
                  blockIndex += 1;
                  openBlock = "text";
                  emit("content_block_start", {
                    type: "content_block_start", index: blockIndex,
                    content_block: { type: "text", text: "" },
                  });
                }
                emit("content_block_delta", {
                  type: "content_block_delta", index: blockIndex,
                  delta: { type: "text_delta", text: delta.content },
                });
                outputTokens += 1;
              }
              for (const call of delta.tool_calls ?? []) {
                if (call.id ?? call.function?.name) {
                  closeBlock();
                  blockIndex += 1;
                  openBlock = "tool";
                  emit("content_block_start", {
                    type: "content_block_start", index: blockIndex,
                    content_block: {
                      type: "tool_use",
                      id: call.id ?? `toolu_pz_${blockIndex}`,
                      name: call.function?.name ?? "unknown",
                      input: {},
                    },
                  });
                }
                if (call.function?.arguments) {
                  emit("content_block_delta", {
                    type: "content_block_delta", index: blockIndex,
                    delta: { type: "input_json_delta", partial_json: call.function.arguments },
                  });
                }
              }
            }
          }
          closeBlock();
          emit("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason(finish), stop_sequence: null },
            usage: { output_tokens: outputTokens },
          });
          emit("message_stop", { type: "message_stop" });
        } catch (err) {
          emit("error", { type: "error", error: { type: "api_error", message: (err as Error).message } });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(sse, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  return app;
}
