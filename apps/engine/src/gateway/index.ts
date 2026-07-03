// Model Gateway (architecture §3.3, Mode 1 only for the skeleton — see
// docs/decisions). Normalizes every provider to one chat() interface.
// Two adapters cover the launch surface: any OpenAI-compatible base URL
// (OpenAI, OpenRouter, Z.AI, vLLM, ...) and local Ollama (the zero-cost path).
import { readSecret } from "../keychain.ts";

export type ModelConnection = {
  id: string;
  role: "plan" | "code" | "thai" | "other";
  mode: "api_key" | "subscription";
  provider: string;
  endpoint: string;
  model: string;
  credential_ref: string | null;
  verified_at: string | null;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatResult = {
  content: string;
};

function isOllama(conn: ModelConnection): boolean {
  return conn.provider === "ollama";
}

async function chatOpenAICompat(
  conn: ModelConnection,
  messages: ChatMessage[],
  maxTokens?: number,
): Promise<ChatResult> {
  const key = conn.credential_ref ? readSecret(conn.credential_ref) : null;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetch(`${conn.endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: conn.model,
      messages,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${conn.provider} returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`${conn.provider} returned no message content`);
  }
  return { content };
}

async function chatOllama(
  conn: ModelConnection,
  messages: ChatMessage[],
): Promise<ChatResult> {
  const res = await fetch(`${conn.endpoint.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: conn.model, messages, stream: false }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ollama returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (typeof content !== "string") {
    throw new Error("ollama returned no message content");
  }
  return { content };
}

export async function chat(
  conn: ModelConnection,
  messages: ChatMessage[],
  maxTokens?: number,
): Promise<ChatResult> {
  return isOllama(conn)
    ? chatOllama(conn, messages)
    : chatOpenAICompat(conn, messages, maxTokens);
}

// "Never accept a key on faith" (architecture §3.4): a live round-trip is the
// only accepted proof of a working connection.
export async function healthCheck(conn: ModelConnection): Promise<void> {
  const result = await chat(
    conn,
    [{ role: "user", content: "Reply with the single word: ok" }],
    16,
  );
  if (!result.content.trim()) {
    throw new Error("provider responded with empty content");
  }
}
