import type { ImageContent, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ClassifierRegistry } from "./backends.ts";
import type { SelectorBackend } from "./settings.ts";
import { selectionState, type EffortState } from "./router.ts";
import { prepareSelectorImages, type ImageWarning } from "./selector-images.ts";
import { getEffortInstructions, getEffortCriteria } from "./effort-policy.ts";

export const CLASSIFIER_RESPONSE_TEXT_LIMIT = 8_192;
export const CLASSIFIER_ERROR_CODES = [
	"request_cancelled", "request_failed", "provider_aborted", "model_unavailable", "availability_failed", "image_preparation_failed",
	"invalid_envelope", "invalid_model", "invalid_answers", "missing_effort", "unexpected_answers",
	"invalid_effort_answer", "invalid_answer_type", "unsupported_effort", "invalid_confidence",
	"invalid_probabilities", "probability_keys_mismatch", "invalid_probability", "probability_sum", "choice_not_max",
] as const;
type ClassifierErrorCode = typeof CLASSIFIER_ERROR_CODES[number];

// 只保存固定枚举；格式看似安全的任意字符串也可能是凭据，不能直接透传。
export const CLASSIFIER_PROVIDER_ERROR_CODES = [
	"ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED",
	"UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
	"rate_limit_exceeded", "insufficient_quota", "invalid_api_key", "authentication_error",
	"permission_denied", "overloaded_error", "server_error", "invalid_request_error", "model_not_found", "context_length_exceeded",
] as const;
type ClassifierProviderErrorCode = typeof CLASSIFIER_PROVIDER_ERROR_CODES[number];
export const CLASSIFIER_FAILURE_STAGES = ["availability", "image_preparation", "provider", "validation"] as const;
type ClassifierFailureStage = typeof CLASSIFIER_FAILURE_STAGES[number];

export interface ClassifierDiagnostics {
	stage: "request" | "validation" | "complete";
	imageWarning?: ImageWarning;
	imagesSent?: number;
	errorCode?: ClassifierErrorCode;
	failureStage?: ClassifierFailureStage;
	/** Only populated when a thrown provider error exposes a structured numeric status. */
	httpStatus?: number;
	providerCode?: ClassifierProviderErrorCode;
	stopReason?: "stop" | "error" | "aborted";
	responseType?: "object";
	responseCharacters?: number;
	/** Normalized successful classifier result, never HTTP bodies or runtime errors. */
	rawText?: string;
	rawTextTruncated?: boolean;
}

class ClassifierValidationError extends Error {
	constructor(readonly code: ClassifierErrorCode) { super(`Classifier returned an invalid decision (${code})`); }
}

export interface ClassifierTiming {
	classifyMs?: number;
	validateMs?: number;
	totalMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

export interface ClassifierInvocation {
	state: EffortState;
	images?: ImageContent[];
	signal: AbortSignal;
	onTiming?: (timing: Readonly<ClassifierTiming>) => void;
	onDiagnostics?: (diagnostics: Readonly<ClassifierDiagnostics>) => void;
	debugResponses?: boolean;
}

export interface ClassifierDecision {
	effort: ModelThinkingLevel;
	model: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export type SelectClassifier = (invocation: ClassifierInvocation) => Promise<ClassifierDecision>;

export async function selectWithClassifier(registry: ClassifierRegistry, { state, images, signal, onTiming, onDiagnostics, debugResponses = false }: ClassifierInvocation, backend: Extract<SelectorBackend, { type: "classifier" }>): Promise<ClassifierDecision> {
	const startedAt = performance.now();
	const timing: ClassifierTiming = {};
	const diagnostics: ClassifierDiagnostics = { stage: "request" };
	let failureStage: ClassifierFailureStage = "availability";
	const elapsed = (since: number) => Math.max(0, Math.round((performance.now() - since) * 10) / 10);
	const report = () => {
		try { onTiming?.({ ...timing }); } catch { /* Ignore observer failures. */ }
		try { onDiagnostics?.({ ...diagnostics }); } catch { /* Ignore observer failures. */ }
	};
	try {
		signal.throwIfAborted();
		const models = await registry.getAvailableOfType("classifier", backend.provider, { signal });
		signal.throwIfAborted();
		const model = models.find((item) => item.provider === backend.provider && item.id === backend.id);
		if (!model) {
			diagnostics.errorCode = "model_unavailable";
			throw new Error("Configured classifier is unavailable in Pi (model or credentials missing)");
		}
		report();
		const classifyStartedAt = performance.now();
		// Authentication and transport belong to Pi. The caller owns the attempt deadline.
		const questions = { effort: { type: "choice" as const, instructions: getEffortInstructions(!!state.execution), criteria: getEffortCriteria(state.supportedEfforts) } };
		failureStage = "image_preparation";
		const wireState = selectionState(state);
		const attachment = await prepareSelectorImages(images ?? [], model, Buffer.byteLength(JSON.stringify({ state: wireState, questions })), signal);
		if (images?.length) diagnostics.imagesSent = attachment.images.length;
		if (attachment.warning) diagnostics.imageWarning = attachment.warning;
		report();
		// 图片仅作为独立附件发送，不进入 JSON 状态或持久化诊断。
		failureStage = "provider";
		const response = await registry.classify(model, { state: wireState, ...(attachment.images.length ? { images: attachment.images } : {}), questions }, { signal, maxRetries: 0 }).finally(() => { timing.classifyMs = elapsed(classifyStartedAt); });
		signal.throwIfAborted();
		if (["stop", "error", "aborted"].includes(response.stopReason)) diagnostics.stopReason = response.stopReason;
		// A failed classification may still have billed usage. Do not infer missing counts.
		if (response.usage) {
			const { input, output, cost } = response.usage;
			if (Number.isFinite(input) && input >= 0) timing.inputTokens = input;
			if (Number.isFinite(output) && output >= 0) timing.outputTokens = output;
			if (Number.isFinite(cost.total) && cost.total >= 0) timing.cost = cost.total;
		}
		if (response.stopReason === "aborted") {
			diagnostics.errorCode = "provider_aborted";
			throw new Error("Classifier provider aborted the request");
		}
		if (response.stopReason !== "stop") throw new Error("Classifier request failed");
		const validationStartedAt = performance.now();
		diagnostics.stage = "validation";
		failureStage = "validation";
		// Only normalized answers are available; never capture errorMessage or unknown fields.
		try {
			const { answers } = parseEnvelope(response);
			const answer = parseChoice(answers.effort, state.supportedEfforts);
			const effort = state.supportedEfforts.find((candidate) => candidate === answer.choice)!;
			diagnostics.stage = "complete";
			// Capture only validated fields. Never log arbitrary answers or resolved credentials.
			const text = JSON.stringify({ model: model.id, answers: { effort: { type: "choice", ...answer } } });
			diagnostics.responseType = "object";
			diagnostics.responseCharacters = text.length;
			if (debugResponses) {
				diagnostics.rawText = text.slice(0, CLASSIFIER_RESPONSE_TEXT_LIMIT);
				diagnostics.rawTextTruncated = text.length > CLASSIFIER_RESPONSE_TEXT_LIMIT;
			}
			return { effort, model: model.id, confidence: answer.confidence, probabilities: answer.probabilities };
		} finally {
			timing.validateMs = elapsed(validationStartedAt);
		}
	} catch (error) {
		diagnostics.failureStage = failureStage;
		if (signal.aborted) {
			diagnostics.errorCode = "request_cancelled";
			throw new Error("Classifier request cancelled");
		}
		if (error instanceof ClassifierValidationError) {
			diagnostics.errorCode = error.code;
			throw error;
		}
		if (diagnostics.errorCode === "provider_aborted" || diagnostics.errorCode === "model_unavailable") throw error;
		// Pi 1.5 的失败结果通常只有 stopReason/errorMessage；绝不从错误正文猜测状态码。
		if (failureStage === "provider") Object.assign(diagnostics, safeProviderFailure(error));
		diagnostics.errorCode = failureStage === "availability" ? "availability_failed" :
			failureStage === "image_preparation" ? "image_preparation_failed" : "request_failed";
		throw new Error("Classifier request failed");
	} finally {
		timing.totalMs = elapsed(startedAt);
		report();
	}
}

function safeProviderFailure(error: unknown): Pick<ClassifierDiagnostics, "httpStatus" | "providerCode"> {
	const result: Pick<ClassifierDiagnostics, "httpStatus" | "providerCode"> = {};
	if (!isRecord(error)) return result;
	try {
		// 只读异常自身的数据属性，不执行 getter，不追踪 cause/response，也不读取正文或请求头。
		const own = (key: string): unknown => Object.getOwnPropertyDescriptor(error, key)?.value;
		const status = own("status") ?? own("statusCode");
		if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) result.httpStatus = status;
		const code = own("code");
		if (CLASSIFIER_PROVIDER_ERROR_CODES.some((allowed) => allowed === code)) result.providerCode = code as ClassifierProviderErrorCode;
	} catch { /* Uninspectable exceptions must not replace the sanitized failure. */ }
	return result;
}

function parseEnvelope(response: unknown): { model: string; answers: Record<string, unknown> } {
	if (!isRecord(response)) throw new ClassifierValidationError("invalid_envelope");
	if (typeof response.model !== "string" || !response.model.trim()) throw new ClassifierValidationError("invalid_model");
	if (!isRecord(response.answers)) throw new ClassifierValidationError("invalid_answers");
	if (!Object.hasOwn(response.answers, "effort")) throw new ClassifierValidationError("missing_effort");
	if (Object.keys(response.answers).length !== 1) throw new ClassifierValidationError("unexpected_answers");
	return { model: response.model, answers: response.answers };
}

function parseChoice(answer: unknown, efforts: readonly string[]): { choice: string; confidence: number; probabilities: Record<string, number> } {
	if (!isRecord(answer)) throw new ClassifierValidationError("invalid_effort_answer");
	if (answer.type !== "choice") throw new ClassifierValidationError("invalid_answer_type");
	const effort = efforts.find((candidate) => candidate === answer.choice);
	if (!effort) throw new ClassifierValidationError("unsupported_effort");
	if (!isProbability(answer.confidence)) throw new ClassifierValidationError("invalid_confidence");
	if (!isRecord(answer.probabilities)) throw new ClassifierValidationError("invalid_probabilities");
	if (Object.keys(answer.probabilities).length !== efforts.length || efforts.some((key) => !Object.hasOwn(answer.probabilities as object, key))) {
		throw new ClassifierValidationError("probability_keys_mismatch");
	}

	let total = 0;
	const probabilities: number[] = [];
	const distribution: Record<string, number> = {};
	for (const candidate of efforts) {
		const probability = answer.probabilities[candidate];
		if (!isProbability(probability)) throw new ClassifierValidationError("invalid_probability");
		total += probability;
		probabilities.push(probability);
		distribution[candidate] = probability;
	}
	const selectedProbability = answer.probabilities[effort] as number;
	// Observed two-decimal responses can sum to 0.99; allow only bounded rounding drift.
	const twoDecimalValues = probabilities.every((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8);
	const sumTolerance = twoDecimalValues ? efforts.length * 0.005 + 1e-8 : 0.001;
	if (Math.abs(total - 1) > sumTolerance) throw new ClassifierValidationError("probability_sum");
	if (probabilities.some((probability) => probability > selectedProbability)) {
		throw new ClassifierValidationError("choice_not_max");
	}
	return { choice: effort, confidence: answer.confidence, probabilities: distribution };
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
