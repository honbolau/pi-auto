import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildStepExecution, messageText, supportsStepMode } from "../src/step-context.ts";

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant", api: "openai-responses", provider: "test", model: "test", content,
	stopReason: "toolUse", timestamp: 0,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
function tool(session: SessionManager, id: string, args: Record<string, string>, isError: boolean, text: string, name = "bash") {
	session.appendMessage(assistant([{ type: "toolCall", id, name, arguments: args }]));
	session.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 });
}

describe("step execution context", () => {
	it("resolves only a successful rerun with matching tool and canonical arguments", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "Fix the test", timestamp: 0 });
		tool(session, "red", { command: "npm test", cwd: "." }, true, "failed");
		tool(session, "edit", { command: "write source" }, false, "written");
		expect(buildStepExecution(session.buildContextEntries()).unresolvedFailures).toHaveLength(1);
		tool(session, "unrelated", { command: "npm run lint" }, false, "lint passed");
		expect(buildStepExecution(session.buildContextEntries()).unresolvedFailures).toHaveLength(1);
		tool(session, "green", { cwd: ".", command: "npm test" }, false, "all tests passed");
		const state = buildStepExecution(session.buildContextEntries());
		expect(state.unresolvedFailures).toEqual([]);
		expect(state.resolvedFailureCount).toBe(1);
		expect(state.recentTools.find(x => x.isError)?.resolved).toBe(true);
		expect(JSON.stringify(state)).not.toContain("npm test");
	});

	it("marks every repeated failure of the same check resolved after a passing rerun", () => {
		const session = SessionManager.inMemory();
		tool(session, "red1", { command: "test" }, true, "failed once");
		tool(session, "red2", { command: "test" }, true, "failed twice");
		tool(session, "green", { command: "test" }, false, "passed");
		const state = buildStepExecution(session.buildContextEntries());
		expect(state.unresolvedFailures).toEqual([]);
		expect(state.resolvedFailureCount).toBe(2);
		expect(state.recentTools.filter(x => x.isError).every(x => x.resolved)).toBe(true);
	});

	it("keeps equal tool names with different checks unresolved", () => {
		const session = SessionManager.inMemory();
		tool(session, "one", { command: "test A" }, true, "A failed");
		tool(session, "two", { command: "test B" }, false, "B passed");
		expect(buildStepExecution(session.buildContextEntries()).unresolvedFailures.map(x => x.text)).toEqual(["A failed"]);
	});

	it("does not carry failed checks across user or compaction boundaries", () => {
		const session = SessionManager.inMemory();
		tool(session, "old", { command: "old check" }, true, "old failure");
		const userId = session.appendMessage({ role: "user", content: "New task", timestamp: 0 });
		expect(buildStepExecution(session.buildContextEntries()).recentTools).toEqual([]);
		tool(session, "new", { command: "new check" }, true, "new failure");
		session.appendCompaction("Active task summary", userId, 100);
		const state = buildStepExecution(session.getBranch());
		expect(state.recentTools).toEqual([]);
		expect(state.compactionSummary).toBe("Active task summary");
	});

	it("bounds result count without cutting important text from a retained result", () => {
		const session = SessionManager.inMemory();
		for (let index = 0; index < 6; index++) tool(session, String(index), { command: String(index) }, false, "x".repeat(8000) + "middle constraint");
		session.appendMessage(assistant([{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Known next step" }]));
		const state = buildStepExecution(session.buildContextEntries());
		expect(state.recentTools).toHaveLength(4);
		expect(state.omittedToolCount).toBe(2);
		expect(state.recentTools[0]?.text).toContain("middle constraint");
		expect(state.assistantProgress).toBe("Known next step");
		expect(JSON.stringify(state)).not.toContain("private reasoning");
	});

	it("extracts text only", () => {
		expect(messageText([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "visible" }, { type: "image", data: "hidden" }])).toBe("visible");
	});

	it.each([["0.98.9", false], ["0.99.0", true], ["0.99.1", true], ["1.0.0", true], ["1.4.9", true], ["1.5.0", true], ["1.5.1", true], ["2.0.0", true], ["invalid", false]])("gates Pi %s", (version, expected) => {
		expect(supportsStepMode(version as string)).toBe(expected);
	});
});
