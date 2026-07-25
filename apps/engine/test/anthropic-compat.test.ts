// WP4 — Anthropic Messages façade (ADR 0006) mounted standalone via Hono,
// exercised with app.request() against a fake upstream OpenAI-compatible
// server (same fake-server pattern as g2-roster.test.ts's fake apps/cloud).
//
// Run:  node --test apps/engine/test/anthropic-compat.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Hono } from "hono";
import { anthropicCompat } from "../src/gateway/anthropic-compat.ts";
import type { ModelConnection } from "../src/gateway/index.ts";

// --- Fake upstream (OpenAI-compatible /chat/completions) --------------------
const upstream = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: { content: `echo: ${body.messages?.[body.messages.length - 1]?.content ?? ""}` },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }),
  );
});

await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
const port = (upstream.address() as { port: number }).port;

const fakeConnection: ModelConnection = {
  id: "conn-1",
  role: "code",
  mode: "api_key",
  provider: "openai-compatible",
  endpoint: `http://127.0.0.1:${port}`,
  model: "fake-model",
  credential_ref: null, // skips the keychain lookup entirely
  verified_at: "2026-07-18T00:00:00.000Z",
};

let currentConn: ModelConnection | undefined = undefined;
const app = new Hono();
app.route("/", anthropicCompat(() => currentConn));

const req = (path: string, init?: RequestInit) =>
  app.request(path, {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

test("POST /v1/messages returns 400 when no model is connected", async () => {
  currentConn = undefined;
  const res = await req("/v1/messages", { body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { type: string; error: { message: string } };
  assert.equal(body.type, "error");
  assert.match(body.error.message, /no verified coding model connected/);
});

test("GET /v1/models is empty when no model is connected", async () => {
  currentConn = undefined;
  const res = await app.request("/v1/models");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown[] };
  assert.deepEqual(body.data, []);
});

test("POST /v1/messages round-trips a non-streaming translation through the connected model", async () => {
  currentConn = fakeConnection;
  const res = await req("/v1/messages", {
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    type: string;
    role: string;
    model: string;
    content: { type: string; text?: string }[];
    stop_reason: string;
    usage: { input_tokens: number; output_tokens: number };
  };
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.equal(body.model, "fake-model");
  assert.equal(body.content.length, 1);
  assert.equal(body.content[0].type, "text");
  assert.equal(body.content[0].text, "echo: hi");
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.usage.input_tokens, 3);
  assert.equal(body.usage.output_tokens, 4);
});

test("GET /v1/models lists the connected model once one is connected", async () => {
  currentConn = fakeConnection;
  const res = await app.request("/v1/models");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { id: string; display_name: string }[] };
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, "fake-model");
  assert.equal(body.data[0].display_name, "openai-compatible/fake-model");
});

test("POST /v1/messages/count_tokens returns a positive token estimate", async () => {
  const res = await req("/v1/messages/count_tokens", {
    body: JSON.stringify({ messages: [{ role: "user", content: "hello there" }] }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { input_tokens: number };
  assert.ok(body.input_tokens >= 1);
});

test.after(() => {
  upstream.close();
});
