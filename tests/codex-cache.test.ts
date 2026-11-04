import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionEvent, type ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { CODEX_CACHE_ENTRY, CodexCacheHistory, registerCodexCache, supportsCodexCache } from "../src/codex-cache.ts";

const model: Model<Api> = {
	provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", name: "Sol", baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const user = (text: string) => ({ role: "user", content: text });
const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
function payload(input: unknown[], effort = "low", extra = {}) {
	return { model: model.id, input, reasoning: { effort, summary: "auto" }, instructions: "stable", prompt_cache_key: "session", ...extra };
}
function create() {
	const history = new CodexCacheHistory();
	const manager = SessionManager.inMemory();
	const send = (value: ReturnType<typeof payload>) => {
		const plan = history.plan(value);
		if (!plan) throw new Error("Expected cache plan");
		if (plan.checkpoint) { manager.appendCustomEntry(CODEX_CACHE_ENTRY, plan.checkpoint); history.accept(plan.checkpoint); }
		return plan.payload as ReturnType<typeof payload>;
	};
	return { history, manager, send };
}

describe("Codex cache history", () => {
	it("pins effort and replays every update at its original boundary, including tool results", () => {
		const h = create();
		const first = h.send(payload([user("one")]));
		const second = h.send(payload([user("one"), { type: "function_call_output", call_id: "call", output: "result" }], "high"));
		const third = h.send(payload([...second.input.filter((v) => !(v as { type?: string }).type?.includes("configuration_update")), user("two")], "low"));
		expect(first.reasoning.effort).toBe("low");
		expect(second.reasoning.effort).toBe("low");
		expect(second.input.at(-1)).toEqual(update("high"));
		expect(second.input.slice(0, first.input.length)).toEqual(first.input);
		expect(third.input.slice(0, second.input.length)).toEqual(second.input);
		expect(third.input.at(-1)).toEqual(update("low"));
	});

	it("does not mutate the original payload or record duplicate retries", () => {
		const h = create();
		const first = payload([user("one")]);
		h.send(first);
		const next = payload([user("one"), user("two")], "max");
		const original = structuredClone(next);
		const sent = h.send(next);
		expect(next).toEqual(original);
		expect(h.send(next)).toEqual(sent);
		expect(h.manager.getBranch().filter((e) => e.type === "custom")).toHaveLength(2);
	});

	it("keeps adjacent updates when cancelled requests have the same input boundary", () => {
		const h = create();
		h.send(payload([user("one")]));
		h.send(payload([user("one")], "high"));
		const sent = h.send(payload([user("one")], "low"));
		expect(sent.input).toEqual([user("one"), update("high"), update("low")]);
	});

	it("restores checkpoints from the active branch, including a fork with a new routing key", () => {
		const h = create();
		h.send(payload([user("one")]));
		const common = h.manager.getLeafId();
		if (!common) throw new Error("Missing checkpoint");
		h.send(payload([user("one"), user("abandoned")], "max"));
		h.manager.branch(common);
		h.history.restore(h.manager.getBranch());
		const sent = h.send(payload([user("one"), user("fork")], "high", { prompt_cache_key: "fork-session" }));
		expect(sent.reasoning.effort).toBe("low");
		expect(sent.input).toEqual([user("one"), user("fork"), update("high")]);
		const restored = new CodexCacheHistory();
		restored.restore(h.manager.getBranch());
		expect(restored.plan(payload([user("one"), user("fork"), user("next")], "low"))?.payload).toMatchObject({
			reasoning: { effort: "low" }, input: [user("one"), user("fork"), update("high"), user("next"), update("low")],
		});
	});

	it.each([
		payload([user("changed")], "high"),
		payload([], "high"),
		payload([user("one"), user("two")], "high", { instructions: "new system prompt" }),
		payload([user("one"), user("two")], "high", { tools: [{ type: "function", name: "new" }] }),
	])("starts a fresh baseline when input or cache-affecting settings change", (next) => {
		const h = create();
		h.send(payload([user("one")]));
		expect(h.send(next)).toEqual(next);
	});

	it("resets only after successful compaction, and treats corrupt metadata conservatively", () => {
		const h = create();
		h.send(payload([user("one")]));
		h.manager.appendCustomEntry(CODEX_CACHE_ENTRY, { version: 1, baseline: "invented", count: -1 });
		h.history.restore(h.manager.getBranch());
		expect(h.send(payload([user("one"), user("two")], "high")).reasoning.effort).toBe("high");
		h.manager.appendCompaction("summary", h.manager.getLeafId() ?? "", 100);
		h.history.restore(h.manager.getBranch());
		expect(h.send(payload([user("summary")], "low")).reasoning.effort).toBe("low");
	});

	it("does not invent missing history when the initial checkpoint has been removed", () => {
		const h = create();
		h.send(payload([user("one")]));
		h.send(payload([user("one"), user("two")], "high"));
		h.history.restore(h.manager.getBranch().slice(1));
		const next = payload([user("one"), user("two"), user("three")], "max");
		expect(h.send(next)).toEqual(next);
	});

	it("does not duplicate native configuration updates", () => {
		const h = create();
		h.send(payload([user("one")]));
		const native = payload([user("one"), update("max")], "medium");
		expect(h.send(native)).toEqual(native);
		expect(h.send(payload([user("one"), user("two")], "high")).reasoning.effort).toBe("high");
	});

	it.each([null, {}, { input: [] }, payload([], "none")])("ignores unsupported payload %j", (value) => {
		expect(new CodexCacheHistory().plan(value)).toBeUndefined();
	});

	it("stores only metadata and digests, not prompts, tools, or output", () => {
		const h = create();
		h.send(payload([user("private sentinel")], "low", { instructions: "secret instruction", tools: [{ private: "secret tool" }] }));
		const text = JSON.stringify(h.manager.getBranch());
		for (const secret of ["private sentinel", "secret instruction", "secret tool"]) expect(text).not.toContain(secret);
	});
});

describe("supported Codex boundary", () => {
	it.each(["gpt-6", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-7", "gpt-10.2-codex"])("recognizes the documented GPT-6+ model family: %s", (id) => {
		expect(supportsCodexCache({ ...model, id })).toBe(true);
	});
	it("rejects older models, malformed names, non-reasoning models, and unrelated endpoints", () => {
		for (const patch of [{ id: "gpt-5.6-sol" }, { id: "gpt-5-codex" }, { id: "gpt-06-sol" }, { id: "gpt-6oops" }, { id: "gpt-6.1-sol/alias" }, { id: "o3" }, { reasoning: false }, { provider: "openai" }, { api: "openai-responses" as const },
			{ baseUrl: "https://api.openai.com/v1" }, { baseUrl: "https://proxy.example/backend-api" },
			{ baseUrl: "https://chatgpt.com/other" }, { baseUrl: "http://chatgpt.com/backend-api" }]) {
			expect(supportsCodexCache({ ...model, ...patch })).toBe(false);
		}
	});

	it("requires opt-in and the active session routing key, and commits before returning a payload", async () => {
		const handlers = new Map<string, (event: ExtensionEvent, ctx: ExtensionContext) => unknown>();
		const manager = SessionManager.inMemory();
		let enabled = false;
		const appendEntry = vi.fn((type: string, data: unknown) => manager.appendCustomEntry(type, data));
		registerCodexCache({ on: (type: string, handler: ExtensionHandler<ExtensionEvent>) => handlers.set(type, handler), appendEntry } as unknown as ExtensionAPI, () => enabled);
		const ctx = { model, sessionManager: manager } as unknown as ExtensionContext;
		const send = async (value: unknown) => handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: value }, ctx);
		const p = payload([user("one")], "low", { prompt_cache_key: manager.getSessionId() });
		expect(await send(p)).toBeUndefined();
		enabled = true;
		expect(await send({ ...p, prompt_cache_key: "compaction" })).toBeUndefined();
		expect(await send(p)).toEqual(p);
		appendEntry.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
		await expect(send({ ...p, reasoning: { ...p.reasoning, effort: "high" } })).rejects.toThrow("disk unavailable");
		expect(await send(p)).toEqual(p);
		expect(appendEntry).toHaveBeenCalledTimes(2);
		await handlers.get("session_compact_failed")?.({ type: "session_compact_failed" } as ExtensionEvent, ctx);
		expect(await send({ ...p, reasoning: { ...p.reasoning, effort: "high" } })).toMatchObject({ reasoning: { effort: "low" } });
		await handlers.get("session_compact")?.({ type: "session_compact" } as ExtensionEvent, ctx);
		expect(await send({ ...p, reasoning: { ...p.reasoning, effort: "high" } })).toMatchObject({ reasoning: { effort: "high" } });
		await handlers.get("model_select")?.({ type: "model_select" } as ExtensionEvent, ctx);
		expect(await send(p)).toEqual(p);
		const count = appendEntry.mock.calls.length;
		expect(await handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: p }, { ...ctx, signal: AbortSignal.abort() })).toBeUndefined();
		expect(appendEntry).toHaveBeenCalledTimes(count);
	});
});
