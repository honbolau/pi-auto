import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type StepToolOutcome = {
	toolName: string;
	isError: boolean;
	text: string;
	resolved?: boolean;
};

export type StepExecutionState = {
	phase: "next-model-call";
	assistantProgress: string;
	recentTools: StepToolOutcome[];
	unresolvedFailures: StepToolOutcome[];
	resolvedFailureCount: number;
	omittedToolCount: number;
	compactionSummary?: string;
};

export function supportsStepMode(version: string): boolean {
	const match = /^(\d+)\.(\d+)\./.exec(version);
	// 0.99.0 已具备原生分类器和逐请求档位刷新，门槛与已实测兼容范围一致。
	return !!match && (Number(match[1]) >= 1 || (Number(match[1]) === 0 && Number(match[2]) >= 99));
}

export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: unknown) => {
		if (!part || typeof part !== "object") return [];
		const block = part as { type?: unknown; text?: unknown };
		return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
	}).join("\n");
}

/** 仅保留当前用户任务及压缩边界后的执行信息，不把旧任务失败带入下一轮。 */
export function buildStepExecution(entries: readonly SessionEntry[]): StepExecutionState {
	let boundary = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "compaction" || (entry?.type === "message" && entry.message.role === "user")) {
			boundary = index;
			break;
		}
	}
	const boundaryEntry = entries[boundary];
	const calls = new Map<string, string>();
	const failures = new Map<string, StepToolOutcome[]>();
	const tools: StepToolOutcome[] = [];
	let assistantProgress = "";
	let resolvedFailureCount = 0;
	for (const entry of entries.slice(boundary + 1)) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			const text = messageText(message.content);
			if (text.trim()) assistantProgress = text;
			for (const part of message.content) {
				if (part.type === "toolCall") {
					// 参数只用于内部匹配，不发送给选档模型，也不写入诊断。
					calls.set(part.id, createHash("sha256").update(JSON.stringify([part.name, canonical(part.arguments)])).digest("hex"));
				}
			}
		} else if (message.role === "toolResult") {
			const outcome = { toolName: message.toolName, isError: message.isError, text: messageText(message.content) };
			const key = calls.get(message.toolCallId) ?? message.toolCallId;
			tools.push(outcome);
			if (outcome.isError) failures.set(key, [...(failures.get(key) ?? []), outcome]);
			else {
				const resolved = failures.get(key) ?? [];
				// 同一检查的成功重跑清除全部旧失败，并标记近期结果，避免历史错误再次抬高档位。
				for (const failure of resolved) failure.resolved = true;
				resolvedFailureCount += resolved.length;
				failures.delete(key);
			}
		}
	}
	return {
		phase: "next-model-call", assistantProgress,
		recentTools: tools.slice(-4), unresolvedFailures: [...failures.values()].flat().slice(-4),
		resolvedFailureCount, omittedToolCount: Math.max(0, tools.length - 4),
		...(boundaryEntry?.type === "compaction" ? { compactionSummary: boundaryEntry.summary } : {}),
	};
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}
