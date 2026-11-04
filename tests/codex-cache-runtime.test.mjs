import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import piAuto from "../src/index.ts";
import { selectWithClassifier } from "../src/classifier.ts";
import { CODEX_CACHE_ENTRY } from "../src/codex-cache.ts";

vi.mock("../src/classifier.ts", async (original) => ({ ...await original(), selectWithClassifier: vi.fn() }));
let directory;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-auto-codex-runtime-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	initTheme("dark", false);
	vi.mocked(selectWithClassifier).mockReset();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

it.each(["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra"])("preserves the actual Codex wire prefix across tools and reload for %s", async (modelId) => {
	await writeFile(join(directory, "pi-auto.json"), JSON.stringify({ mode: "step", codexCache: true, backend: { type: "classifier", provider: "test", id: "judge" } }));
	for (const effort of ["high", "low", "max"]) vi.mocked(selectWithClassifier).mockResolvedValueOnce({ effort, model: "judge", confidence: 1, probabilities: { [effort]: 1 } });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const registry = new ModelRegistry(runtime);
	const calls = [];
	const errors = [];
	// 仅本地模拟传输；仍经过真正的 Codex 序列化器和 AgentSession。
	const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64")}.test`;
	registry.registerProvider("openai-codex", {
		api: "openai-codex-responses", apiKey: jwt, baseUrl: "https://chatgpt.com/backend-api",
		models: [{ id: modelId, name: modelId, reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 8192,
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple: (model, context, options) => streamCodex(model, context, {
			...options, transport: "sse", fetch: async (_url, init) => {
				const body = new Headers(init.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(init.body).toString("utf8") : String(init.body);
				calls.push(JSON.parse(body));
				const first = calls.length === 1;
				const id = `response_${calls.length}`;
				const item = first
					? { type: "function_call", id: "fc_check", call_id: "call_check", name: "check", arguments: "{}", status: "completed" }
					: { type: "message", id: `msg_${calls.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] };
				const events = [
					{ type: "response.created", response: { id } },
					{ type: "response.output_item.added", output_index: 0, item },
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 5 } } },
				];
				return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
			},
		}),
	});
	const model = runtime.getModel("openai-codex", modelId);
	if (!model) throw new Error("Missing synthetic model");
	const manager = SessionManager.create(directory, directory);
	async function create(sessionManager) {
		const loader = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Stable synthetic runtime prompt.",
			extensionFactories: [piAuto, pi => pi.registerTool({ name: "check", label: "Check", description: "Synthetic check", parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "Verified" }], details: {} }) })],
		});
		await loader.reload();
		const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model, resourceLoader: loader, noTools: "builtin", sessionManager,
			settingsManager: SettingsManager.inMemory({ transport: "sse", cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }) });
		await session.bindExtensions({ mode: "sdk", onError: error => errors.push(error) });
		return session;
	}
	let session = await create(manager);
	try {
		await session.prompt("Run the check");
		expect(calls, JSON.stringify(session.messages.filter(m => m.role === "assistant").map(m => ({ stopReason: m.stopReason, error: m.errorMessage })))).toHaveLength(2);
		expect(calls.map(c => c.reasoning.effort)).toEqual(["high", "high"]);
		expect(calls[1].input.slice(0, calls[0].input.length)).toEqual(calls[0].input);
		expect(calls[1].input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "low" } });
		expect(calls[1].input.at(-2).type).toBe("function_call_output");
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing persisted session");
		session.dispose();
		const restored = SessionManager.open(file, directory);
		session = await create(restored);
		await session.prompt("Explain the result");
		expect(calls).toHaveLength(3);
		expect(calls[2].reasoning.effort).toBe("high");
		expect(calls[2].input.slice(0, calls[1].input.length)).toEqual(calls[1].input);
		expect(calls[2].input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "max" } });
		expect(restored.getBranch().filter(e => e.type === "custom" && e.customType === CODEX_CACHE_ENTRY)).toHaveLength(3);
		expect(errors).toEqual([]);
	} finally { session.dispose(); }
});
