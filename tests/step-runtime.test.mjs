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
	async function create(mode, { steering = false, onCheck } = {}) {
		await writeFile(join(directory, "pi-auto.json"), JSON.stringify({ mode, backend: { type: "classifier", provider: "test", id: "judge" } }));
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		const calls = [];
		const requestMessages = [];
		const turnStarts = [];
		const errors = [];
		let session;
		registry.registerProvider("step-test", {
			api: "openai-responses", apiKey: "synthetic", baseUrl: "https://example.test",
			models: [{ id: "physical", name: "Physical", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			streamSimple: (model, context, options) => {
				calls.push({ model: model.id, effort: options.reasoning });
				requestMessages.push(structuredClone(context.messages));
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
			extensionFactories: [piAuto, (pi) => {
				pi.on("turn_start", (event, ctx) => {
					turnStarts.push({ turnIndex: event.turnIndex, pending: ctx.hasPendingMessages() });
				});
				pi.registerTool({
					name: "check", label: "Check", description: "Synthetic check",
					parameters: { type: "object", properties: {}, required: [] },
					execute: async () => {
						if (steering) await session.steer("New steering task: explain only, do not edit.");
						await onCheck?.(session);
						return { content: [{ type: "text", text: "Check complete" }], details: {} };
					},
				});
			}],
		});
		await loader.reload();
		const result = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime: runtime, model, thinkingLevel: "medium",
			resourceLoader: loader, noTools: "builtin", sessionManager: SessionManager.inMemory(directory),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, defaultThinkingLevel: "medium" }),
		});
		session = result.session;
		await session.bindExtensions({ mode: "sdk", onError: error => errors.push(error) });
		return { session, calls, requestMessages, turnStarts, errors };
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
		const h = await create("step", { steering: true });
		try {
			await h.session.prompt("Original implementation goal");
			expect(h.errors).toEqual([]);
			expect(h.calls.at(-1)?.effort).toBe("medium");
			expect(vi.mocked(selectWithClassifier).mock.lastCall?.[1].state.task).toContain("New steering task");
		} finally { h.session.dispose(); }
	});

	it("reselects tool continuation effort while a follow-up is still pending", async () => {
		const original = "Original implementation goal";
		const followUp = "Follow-up task: explain the result";
		vi.mocked(selectWithClassifier).mockImplementation(async (_registry, { state }) => {
			const effort = state.task === followUp ? "medium" : state.execution?.recentTools.length ? "low" : "high";
			return { effort, model: "judge", confidence: 1, probabilities: { [effort]: 1 } };
		});
		const h = await create("step", { onCheck: session => session.followUp(followUp) });
		try {
			await h.session.prompt(original);
			expect(h.errors).toEqual([]);
			// followUp 尚未送入当前请求时也必须重选工具续轮，不能以 hasPendingMessages 跳过。
			expect(h.turnStarts).toEqual([
				{ turnIndex: 0, pending: false },
				{ turnIndex: 1, pending: true },
				{ turnIndex: 2, pending: true },
			]);
			expect(h.calls).toEqual([
				{ model: "physical", effort: "high" },
				{ model: "physical", effort: "low" },
				{ model: "physical", effort: "medium" },
			]);
			const userTexts = h.requestMessages.map(messages => messages.filter(message => message.role === "user")
				.map(message => message.content.filter(part => part.type === "text").map(part => part.text).join("\n")));
			expect(userTexts).toEqual([[original], [original], [original, followUp]]);
			expect(h.requestMessages[1]).toEqual(expect.arrayContaining([
				expect.objectContaining({ role: "toolResult", toolName: "check" }),
			]));
			const states = vi.mocked(selectWithClassifier).mock.calls.map(([, invocation]) => invocation.state);
			expect(states).toEqual(expect.arrayContaining([
				expect.objectContaining({ task: original, execution: expect.objectContaining({
					recentTools: [expect.objectContaining({ toolName: "check", text: "Check complete" })],
				}) }),
			]));
			expect(states.at(-1)).toMatchObject({ task: followUp, execution: { recentTools: [] } });
			expect(h.session.model.id).toBe("physical");
		} finally { h.session.dispose(); }
	});

	it("reselects from tool results even when queued steering repeats the same task", async () => {
		const task = "Original implementation goal";
		vi.mocked(selectWithClassifier).mockImplementation(async (_registry, { state }) => {
			const effort = state.execution?.recentTools.length ? "low" : "high";
			return { effort, model: "judge", confidence: 1, probabilities: { [effort]: 1 } };
		});
		const h = await create("step", { onCheck: session => session.steer(task) });
		try {
			await h.session.prompt(task);
			expect(h.errors).toEqual([]);
			expect(h.turnStarts).toEqual([
				{ turnIndex: 0, pending: false },
				{ turnIndex: 1, pending: true },
			]);
			// 同文同图的 message_end 不补选；工具结果必须已在 turn_start 影响物理请求。
			expect(h.calls).toEqual([
				{ model: "physical", effort: "high" },
				{ model: "physical", effort: "low" },
			]);
			const users = h.requestMessages[1].filter(message => message.role === "user");
			expect(users).toHaveLength(2);
			for (const user of users) expect(user.content).toEqual([{ type: "text", text: task }]);
			expect(selectWithClassifier).toHaveBeenCalledTimes(2);
			const state = vi.mocked(selectWithClassifier).mock.lastCall[1].state;
			expect(state).toMatchObject({ task, execution: {
				recentTools: [{ toolName: "check", text: "Check complete", isError: false }],
			} });
			expect(h.session.model.id).toBe("physical");
		} finally { h.session.dispose(); }
	});
});
