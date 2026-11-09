import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DECISION_ENTRY_TYPE, type EffortDecision, type SelectionAttempt } from "../src/selection-ui.ts";
import { SELECTION_STATISTICS_LIMIT, summarizeSelection } from "../src/statistics.ts";

function entry(overrides: Partial<EffortDecision> = {}, id = "decision", parentId: string | null = null): CustomEntry<EffortDecision> {
	return {
		type: "custom", customType: DECISION_ENTRY_TYPE, id, parentId, timestamp: "2026-01-01T00:00:00.000Z",
		data: {
			status: "selected", model: "test/current", previousEffort: "medium", effort: "low",
			reason: "private prompt must never appear in metrics", routerModel: "test/selector", routerEffort: "low", elapsedMs: 100,
			...overrides,
		},
	};
}

function attempt(backend: SelectionAttempt["backend"], outcome: SelectionAttempt["outcome"] = "selected"): SelectionAttempt {
	return { backend, outcome, elapsedMs: 10, timeoutMs: 1000 };
}

function usage(cost: number): NonNullable<EffortDecision["selectorUsage"]> {
	return { effort: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost } };
}

describe("branch-local selection statistics", () => {
	it("returns an empty, bounded summary without manufacturing latency or a success rate", () => {
		expect(summarizeSelection([])).toEqual({
			sampleCount: 0,
			outcomes: { selectorSelected: 0, defaultFallback: 0, noCall: 0, skipped: 0, cancelled: 0, unknown: 0 },
			elapsedMs: { p50: undefined, p95: undefined }, effortTransitions: {}, failureCodes: {},
			cost: { total: 0, classifier: 0, selector: 0, reportedRequests: 0, attemptedRequests: 0, missingCostRequests: 0, unknownDecisions: 0, complete: true },
		});
	});

	it("keeps only the newest 100 valid decisions, not the newest 100 arbitrary entries", () => {
		const entries = Array.from({ length: 110 }, (_, index) => entry({ elapsedMs: index + 1 }, String(index)));
		const invalid = entry();
		Object.assign(invalid.data!, { elapsedMs: -1 });
		const result = summarizeSelection([...entries, ...Array.from({ length: 105 }, () => invalid)]);
		expect(SELECTION_STATISTICS_LIMIT).toBe(100);
		expect(result.sampleCount).toBe(100);
		expect(result.elapsedMs).toEqual({ p50: 60, p95: 105 });
		expect(result.effortTransitions).toEqual({ "medium -> low": 100 });
	});

	it("uses nearest-rank percentiles including zero and single-sample elapsed times", () => {
		expect(summarizeSelection([entry({ elapsedMs: 0 })]).elapsedMs).toEqual({ p50: 0, p95: 0 });
		expect(summarizeSelection([entry({ elapsedMs: 20 }), entry({ elapsedMs: 0 }), entry({ elapsedMs: 10 }), entry({ elapsedMs: 30 })]).elapsedMs)
			.toEqual({ p50: 10, p95: 30 });
	});

	it("does not follow sibling entries or retain cross-branch state", () => {
		const root = entry({ elapsedMs: 10 }, "root");
		const left = entry({ effort: "high", elapsedMs: 500 }, "left", root.id);
		const right = entry({ effort: "minimal", elapsedMs: 20 }, "right", root.id);
		const leftSummary = summarizeSelection([root, left]);
		const rightSummary = summarizeSelection([root, right]);
		expect(leftSummary.effortTransitions).toEqual({ "medium -> low": 1, "medium -> high": 1 });
		expect(rightSummary.effortTransitions).toEqual({ "medium -> low": 1, "medium -> minimal": 1 });
		expect(rightSummary.elapsedMs.p95).toBe(20);
		expect(summarizeSelection([root, left])).toEqual(leftSummary);
	});

	it("counts selector, default fallback, no-call, skipped and cancelled independently of selected status", () => {
		const result = summarizeSelection([
			entry({ actualBackend: "test/classifier", selectorAttempts: [attempt("classifier")] }),
			entry({ actualBackend: "test/current (fallback)", selectorAttempts: [attempt("classifier", "failed"), attempt("current-model")] }),
			entry({ actualBackend: "default", selectorAttempts: [attempt("classifier", "failed")] }),
			entry({ actualBackend: "default", status: "kept", effort: "medium", selectorAttempts: [attempt("classifier", "failed")] }),
			entry({ actualBackend: "default", routerModel: undefined, routerEffort: undefined, selectorAttempts: [attempt("classifier")] }),
			entry({ status: "kept", selectorAttempts: [attempt("current-model", "skipped")] }),
			entry({ status: "cancelled", selectorAttempts: [attempt("classifier", "cancelled")] }),
		]);
		expect(result.outcomes).toEqual({ selectorSelected: 2, defaultFallback: 2, noCall: 1, skipped: 1, cancelled: 1, unknown: 0 });
		expect(result.effortTransitions).toEqual({ "medium -> low": 6, "medium -> medium": 1 });
	});

	it("preserves legacy decisions without optional diagnostics but never treats absent usage as free", () => {
		const legacy = entry();
		const ambiguousDefault = entry({ actualBackend: "default", routerModel: undefined });
		const unknownSelection = entry({ routerModel: undefined });
		const oldDiagnostics = entry();
		Object.assign(oldDiagnostics.data!, { jevTiming: { cost: 9 }, jevDiagnostics: { rawText: "secret" }, selectorAttempts: [{ backend: "jev" }] });
		const result = summarizeSelection([legacy, ambiguousDefault, unknownSelection, oldDiagnostics]);
		expect(result.sampleCount).toBe(4);
		expect(result.outcomes.selectorSelected).toBe(2);
		expect(result.outcomes.unknown).toBe(2);
		expect(result.cost.total).toBe(0);
		expect(result.cost.unknownDecisions).toBe(4);
		expect(result.cost.complete).toBe(false);
	});

	it("recognizes legacy default fallback with a recorded selector but keeps missing traces uncertain", () => {
		const result = summarizeSelection([entry({ actualBackend: "default", classifierTiming: { cost: 0.02 } })]);
		expect(result.outcomes.defaultFallback).toBe(1);
		expect(result.outcomes.selectorSelected).toBe(0);
		expect(result.cost).toMatchObject({ total: 0.02, unknownDecisions: 1, complete: false });
	});

	it("does not infer complete coverage from an empty trace when a selector invocation is recorded", () => {
		const result = summarizeSelection([entry({ selectorAttempts: [] })]);
		expect(result.cost).toMatchObject({ attemptedRequests: 1, missingCostRequests: 1, complete: false });
	});

	it("validates persisted entries through readDecision and discards malformed records", () => {
		const invalids: SessionEntry[] = [
			{ ...entry(), customType: "other" },
			{ ...entry(), data: undefined },
			{ ...entry(), data: [] },
		] as SessionEntry[];
		for (const data of [{ status: "bad" }, { effort: "unknown" }, { elapsedMs: NaN }, { selectorUsage: { effort: { cost: -1 } } }, { selectorAttempts: [{}] }]) {
			const invalid = entry();
			Object.assign(invalid.data!, data);
			invalids.push(invalid);
		}
		const valid = entry();
		// 失效的可选诊断由 readDecision 丢弃，不应隐藏有效决策。
		Object.assign(valid.data!, { classifierTiming: { cost: -1 }, classifierDiagnostics: { errorCode: "private" } });
		const result = summarizeSelection([...invalids, valid]);
		expect(result.sampleCount).toBe(1);
		expect(result.failureCodes).toEqual({});
		expect(result.cost.complete).toBe(false);
	});

	it("sums billed classifier failure plus chat fallback, including validation failure costs", () => {
		const result = summarizeSelection([entry({
			actualBackend: "test/current (fallback)",
			classifierTiming: { cost: 0.02 }, selectorUsage: usage(0.03),
			classifierDiagnostics: { stage: "validation", errorCode: "missing_effort" },
			selectorAttempts: [attempt("classifier", "failed"), attempt("current-model")],
		})]);
		expect(result.outcomes.selectorSelected).toBe(1);
		expect(result.failureCodes).toEqual({ missing_effort: 1 });
		expect(result.cost).toEqual({ total: 0.05, classifier: 0.02, selector: 0.03, reportedRequests: 2, attemptedRequests: 2, missingCostRequests: 0, unknownDecisions: 0, complete: true });
	});

	it("distinguishes an explicitly reported zero cost from missing cost", () => {
		const zero = summarizeSelection([entry({ classifierTiming: { cost: 0 }, selectorAttempts: [attempt("classifier")] })]);
		const unknown = summarizeSelection([entry({ classifierTiming: { inputTokens: 0 }, selectorAttempts: [attempt("classifier")] })]);
		expect(zero.cost).toMatchObject({ total: 0, reportedRequests: 1, attemptedRequests: 1, missingCostRequests: 0, complete: true });
		expect(unknown.cost).toMatchObject({ total: 0, reportedRequests: 0, attemptedRequests: 1, missingCostRequests: 1, complete: false });
	});

	it("does not charge a no-call single choice or a skipped pre-request attempt", () => {
		const result = summarizeSelection([
			entry({ actualBackend: "default", routerModel: undefined, selectorAttempts: [attempt("chat")] }),
			entry({ status: "kept", routerModel: undefined, selectorAttempts: [attempt("current-model", "skipped")] }),
		]);
		expect(result.cost).toMatchObject({ total: 0, reportedRequests: 0, attemptedRequests: 0, missingCostRequests: 0, complete: true });
		expect(result.outcomes).toMatchObject({ noCall: 1, skipped: 1, selectorSelected: 0, defaultFallback: 0 });
	});

	it("marks missing primary or fallback cost as incomplete even when the other call is billed", () => {
		for (const diagnostics of [{ classifierTiming: { cost: 0.02 } }, { selectorUsage: usage(0.03) }]) {
			const result = summarizeSelection([entry({
				...diagnostics, selectorAttempts: [attempt("classifier", "failed"), attempt("current-model")],
			})]);
			expect(result.cost).toMatchObject({ reportedRequests: 1, attemptedRequests: 2, missingCostRequests: 1, complete: false });
		}
	});

	it("does not assume both chat retries are covered by the single persisted usage slot", () => {
		const result = summarizeSelection([entry({ selectorUsage: usage(0.03), selectorAttempts: [attempt("chat", "failed"), attempt("current-model")] })]);
		expect(result.cost).toMatchObject({ total: 0.03, reportedRequests: 1, attemptedRequests: 2, missingCostRequests: 1, complete: false });
	});

	it("retains billed costs for cancelled or default-restored selections and counts safe failure codes", () => {
		const entries = [entry({
			status: "cancelled", classifierTiming: { cost: 0.01 }, classifierDiagnostics: { stage: "request", errorCode: "request_cancelled" },
			selectorAttempts: [attempt("classifier", "cancelled")],
		}), entry({
			actualBackend: "default", classifierTiming: { cost: 0.02 }, selectorUsage: usage(0.03),
			classifierDiagnostics: { stage: "validation", errorCode: "missing_effort" },
			selectorAttempts: [attempt("classifier", "failed"), attempt("current-model", "failed")],
		}), entry({ classifierDiagnostics: { stage: "validation", errorCode: "missing_effort" } })];
		const result = summarizeSelection(entries);
		expect(result.cost.total).toBeCloseTo(0.06);
		expect(result.failureCodes).toEqual({ request_cancelled: 1, missing_effort: 2 });
	});

	it("never returns prompts, raw responses, reasons, entry IDs or model identifiers and does not mutate input", () => {
		const entries = [entry({
			classifierDiagnostics: { stage: "validation", errorCode: "missing_effort", responseType: "object", responseCharacters: 6, rawText: "secret", rawTextTruncated: false },
			selectorResponses: { effort: { stopReason: "stop", contentTypes: ["text"], textCharacters: 6, rawText: "secret", rawTextTruncated: false } },
			selectorAttempts: [{ ...attempt("classifier", "failed"), reason: "secret request body" }],
		}, "secret-entry-id")];
		const before = structuredClone(entries);
		Object.freeze(entries[0]!.data);
		const result = summarizeSelection(entries);
		expect(entries).toEqual(before);
		const serialized = JSON.stringify(result);
		for (const privateText of ["secret", "private prompt", "test/current", "test/selector", "request body"]) expect(serialized).not.toContain(privateText);
	});
});
