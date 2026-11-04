import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import piAuto from "../src/index.ts";
import { selectWithClassifier } from "../src/classifier.ts";
import { supportsStepMode } from "../src/step-context.ts";

vi.mock("../src/classifier.ts", async (original) => ({ ...await original(), selectWithClassifier: vi.fn() }));
let directory;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-auto-step-runtime-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	initTheme("dark", false);
	vi.mocked(selectWithClassifier).mockReset();
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

describe.skipIf(!supportsStepMode(VERSION))("real Pi request boundaries", () => {
	async function create(mode, steering = false) {
		await writeFile(join(directory, "pi-auto.json"), JSON.stringify({ mode, backend: { type: "classifier", provider: "test", id: "judge" } }));
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		const calls = [];
		const errors = [];
		let session;
		registry.registerProvider("step-test", {
			api: "openai-responses", apiKey: "synthetic", baseUrl: "https://example.test",
			models: [{ id: "physical", name: "Physical", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			streamSimple: (model, _context, options) => {
				calls.push({ model: model.id, effort: options.reasoning });
				const first = calls.length === 1;
				const response = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: first ? [{ type: "toolCall", id: "check-1", name: "check", arguments: {} }] : [{ type: "text", text: "Done" }],
					stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: response.stopReason, message: response });
				stream.end();
				return stream;
			},
		});
		const model = runtime.getModel("step-test", "physical");
		expect(model).toBeDefined();
		const loader = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Test runtime boundaries.",
			extensionFactories: [piAuto, (pi) => pi.registerTool({
				name: "check", label: "Check", description: "Synthetic check",
				parameters: { type: "object", properties: {}, required: [] },
				execute: async () => {
					if (steering) await session.steer("New steering task: explain only, do not edit.");
					return { content: [{ type: "text", text: "Check complete" }], details: {} };
				},
			})],
		});
		await loader.reload();
		const result = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime: runtime, model, thinkingLevel: "medium",
			resourceLoader: loader, noTools: "builtin", sessionManager: SessionManager.inMemory(directory),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, defaultThinkingLevel: "medium" }),
		});
		session = result.session;
		await session.bindExtensions({ mode: "sdk", onError: error => errors.push(error) });
		return { session, calls, errors };
	}

	it.each(["turn", "step"])("applies %s effort to the immediately following physical request", async (mode) => {
		vi.mocked(selectWithClassifier)
			.mockResolvedValueOnce({ effort: "high", model: "judge", confidence: 1, probabilities: { high: 1 } })
			.mockResolvedValueOnce({ effort: "low", model: "judge", confidence: 1, probabilities: { low: 1 } });
		const h = await create(mode);
		try {
			await h.session.prompt("Original user goal");
			// 经过真正的 AgentSession/AgentLoop，不只是模拟触发扩展事件。
			expect(h.errors).toEqual([]);
			expect(h.calls).toEqual([{ model: "physical", effort: "high" }, { model: "physical", effort: mode === "step" ? "low" : "high" }]);
			expect(h.session.model.id).toBe("physical");
			expect(selectWithClassifier).toHaveBeenCalledTimes(mode === "step" ? 2 : 1);
		} finally { h.session.dispose(); }
	});

	it("reselects for steering queued between turns before sending the next request", async () => {
		for (const effort of ["high", "low", "medium"]) vi.mocked(selectWithClassifier).mockResolvedValueOnce({ effort, model: "judge", confidence: 1, probabilities: { [effort]: 1 } });
		const h = await create("step", true);
		try {
			await h.session.prompt("Original implementation goal");
			expect(h.errors).toEqual([]);
			expect(h.calls.at(-1)?.effort).toBe("medium");
			expect(vi.mocked(selectWithClassifier).mock.lastCall?.[1].state.task).toContain("New steering task");
		} finally { h.session.dispose(); }
	});
});
