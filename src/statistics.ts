import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readDecision, type EffortDecision } from "./selection-ui.ts";

export const SELECTION_STATISTICS_LIMIT = 100;

export interface SelectionStatistics {
	sampleCount: number;
	outcomes: {
		/** Includes current-model fallback; not a classifier/task success metric. */
		selectorSelected: number;
		defaultFallback: number;
		noCall: number;
		skipped: number;
		cancelled: number;
		unknown: number;
	};
	elapsedMs: { p50: number | undefined; p95: number | undefined };
	/** Includes unchanged efforts, e.g. "medium -> medium". */
	effortTransitions: Record<string, number>;
	failureCodes: Record<string, number>;
	cost: {
		/** Reported catalog estimates, not an invoice or a claim of free usage. */
		total: number;
		classifier: number;
		selector: number;
		reportedRequests: number;
		/** Recorded/potential requests; preflight failures can overcount actual calls. */
		attemptedRequests: number;
		missingCostRequests: number;
		/** Older entries without an attempt trace may conceal retries. */
		unknownDecisions: number;
		complete: boolean;
	};
}

/**
 * Supply only the active branch, in session order (oldest first), not all session entries.
 * No session traversal, IO, prompt text, model names or raw diagnostics escape this aggregate.
 */
export function summarizeSelection(branch: readonly SessionEntry[]): SelectionStatistics {
	const decisions: EffortDecision[] = [];
	for (let index = branch.length - 1; index >= 0 && decisions.length < SELECTION_STATISTICS_LIMIT; index--) {
		const decision = readDecision(branch[index]!);
		if (decision) decisions.push(decision);
	}
	const summary: SelectionStatistics = {
		sampleCount: decisions.length,
		outcomes: { selectorSelected: 0, defaultFallback: 0, noCall: 0, skipped: 0, cancelled: 0, unknown: 0 },
		elapsedMs: { p50: undefined, p95: undefined },
		effortTransitions: {},
		failureCodes: {},
		cost: { total: 0, classifier: 0, selector: 0, reportedRequests: 0, attemptedRequests: 0, missingCostRequests: 0, unknownDecisions: 0, complete: true },
	};
	for (const decision of decisions) {
		const noCall = isSingleChoiceNoCall(decision);
		// selected 只表示最终应用了档位；恢复默认值和单选项都不是分类器成功。
		if (decision.status === "cancelled") summary.outcomes.cancelled++;
		else if (noCall) summary.outcomes.noCall++;
		else if (decision.actualBackend === "default" && (decision.routerModel || decision.selectorAttempts !== undefined)) summary.outcomes.defaultFallback++;
		else if (decision.status === "kept") summary.outcomes.skipped++;
		else if (decision.actualBackend !== "default" && (decision.routerModel || decision.actualBackend)) summary.outcomes.selectorSelected++;
		else summary.outcomes.unknown++;

		increment(summary.effortTransitions, `${decision.previousEffort} -> ${decision.effort}`);
		if (decision.classifierDiagnostics?.errorCode) increment(summary.failureCodes, decision.classifierDiagnostics.errorCode);
		addCost(summary.cost, decision, noCall);
	}
	const elapsed = decisions.map((decision) => decision.elapsedMs).sort((a, b) => a - b);
	// nearest-rank：不插值，单样本和零耗时都保留原值。
	summary.elapsedMs.p50 = percentile(elapsed, 0.5);
	summary.elapsedMs.p95 = percentile(elapsed, 0.95);
	summary.cost.total = summary.cost.classifier + summary.cost.selector;
	summary.cost.complete = summary.cost.missingCostRequests === 0 && summary.cost.unknownDecisions === 0;
	return summary;
}

function isSingleChoiceNoCall(decision: EffortDecision): boolean {
	return decision.actualBackend === "default" && !decision.routerModel &&
		decision.selectorAttempts?.length === 1 && decision.selectorAttempts[0]!.outcome === "selected" &&
		!decision.classifierTiming && !decision.classifierDiagnostics && !decision.selectorUsage?.effort && !decision.selectorResponses?.effort;
}

function addCost(cost: SelectionStatistics["cost"], decision: EffortDecision, noCall: boolean): void {
	const classifierCost = decision.classifierTiming?.cost;
	const selectorCost = decision.selectorUsage?.effort?.cost;
	const classifierReports = classifierCost === undefined ? 0 : 1;
	const selectorReports = selectorCost === undefined ? 0 : 1;
	cost.classifier += classifierCost ?? 0;
	cost.selector += selectorCost ?? 0;
	cost.reportedRequests += classifierReports + selectorReports;

	let classifierAttempts = 0;
	let selectorAttempts = 0;
	for (const attempt of decision.selectorAttempts ?? []) {
		// skipped 在请求前返回；单选项虽记录 selected，也没有发出请求。
		if (attempt.outcome === "skipped" || noCall) continue;
		if (attempt.backend === "classifier") classifierAttempts++;
		else selectorAttempts++;
	}
	classifierAttempts = Math.max(classifierAttempts, decision.classifierTiming || decision.classifierDiagnostics ? 1 : 0);
	selectorAttempts = Math.max(selectorAttempts, decision.selectorUsage?.effort || decision.selectorResponses?.effort ? 1 : 0);
	if (decision.selectorAttempts === undefined) cost.unknownDecisions++;
	if (decision.routerModel && classifierAttempts + selectorAttempts === 0) selectorAttempts = 1;
	// 两次 chat 重试目前共用一个 usage 槽位：只能累计已报告金额，不能假定另一笔免费。
	cost.attemptedRequests += classifierAttempts + selectorAttempts;
	cost.missingCostRequests += Math.max(0, classifierAttempts - classifierReports) + Math.max(0, selectorAttempts - selectorReports);
}

function percentile(sorted: readonly number[], fraction: number): number | undefined {
	return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : undefined;
}

function increment(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}
