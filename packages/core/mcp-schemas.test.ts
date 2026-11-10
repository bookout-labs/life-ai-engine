import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: 'data:text/javascript,export const env = {PUBLIC_ORIGIN: "https://synthetic.test"}; export class WorkerEntrypoint {}',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { tools } = await import(new URL("../../apps/mcp/worker.ts", import.meta.url).href);
hooks.deregister();

test("every MCP tool advertises an object without top-level schema combinators", async () => {
  const response = await createMcpHandler(() => tools({})).fetch(
    new Request("https://synthetic.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  const payload = JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? ""));
  const listed = z
    .object({
      result: z.object({
        tools: z.array(
          z.object({
            name: z.string(),
            inputSchema: z.record(z.string(), z.unknown()),
          }),
        ),
      }),
    })
    .parse(payload).result.tools;
  assert.ok(listed.some((tool) => tool.name === "record_gift"));
  for (const tool of listed) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    for (const keyword of ["oneOf", "anyOf", "allOf"]) {
      assert.equal(Object.hasOwn(tool.inputSchema, keyword), false, `${tool.name} has top-level ${keyword}`);
    }
  }
});

test("record_gift rejects incomplete actions before database access", async () => {
  for (const [action, field] of [
    ["occasion", "title"],
    ["recipient", "member_id"],
    ["add_gift", "recipient_id"],
    ["update_gift", "gift_id"],
    ["status", "gift_id"],
  ]) {
    const response = await createMcpHandler(() => tools({})).fetch(
      new Request("https://synthetic.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "record_gift",
            arguments: {
              request_id: crypto.randomUUID(),
              action,
            },
          },
        }),
      }),
    );
    const text = await response.text();
    assert.match(text, /"isError":true/);
    assert.ok(text.includes(field ?? ""), `${action} reports its missing ${field}`);
    assert.doesNotMatch(text, /Retry with the same request_id/);
  }
});
