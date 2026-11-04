import { createHash, randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

export const CODEX_CACHE_ENTRY = "pi-auto-codex-cache";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = typeof EFFORTS[number];
type RecordValue = Record<string, unknown>;
type Checkpoint = {
	version: 1; start: boolean; lineage: string; scope: string; baseline: Effort; effort: Effort; count: number; hash: string;
};
type Update = { at: number; effort: Effort };
type State = { last: Checkpoint; updates: Update[] };
type Reset = { version: 1; reset: true };
type Plan = { payload: unknown; checkpoint?: Checkpoint | Reset };

function object(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function effort(value: unknown): value is Effort {
	return typeof value === "string" && EFFORTS.some((level) => level === value);
}
function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function digest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function checkpoint(value: unknown): value is Checkpoint {
	return object(value) && value.version === 1 && typeof value.start === "boolean" && typeof value.lineage === "string" && value.lineage.length > 0 &&
		digest(value.scope) && effort(value.baseline) && effort(value.effort) &&
		typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 0 && digest(value.hash);
}

export function supportsCodexCache(model: Model<Api> | undefined): boolean {
	if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses" || !model.reasoning) return false;
	// Pi 的 Codex 目录尚未暴露后端更新能力位，按官方 GPT-6 及后续型号族识别，不能仅放行 Sol。
	const family = /^gpt-([1-9]\d*)(?:\.\d+)?(?:-[a-z0-9]+)*$/.exec(model.id);
	if (!family || Number(family[1]) < 6) return false;
	// 型号范围与端点能力分开判断，不把官方支持范围自动套用到代理或其他接口。
	try {
		const url = new URL(model.baseUrl);
		return url.protocol === "https:" && url.host === "chatgpt.com" && !url.username && !url.password && !url.search && !url.hash &&
			["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"].includes(url.pathname.replace(/\/$/, ""));
	} catch { return false; }
}

export class CodexCacheHistory {
	private state: State | undefined;

	restore(entries: readonly SessionEntry[]): void {
		this.state = undefined;
		for (const entry of entries) {
			if (entry.type === "compaction" || entry.type === "model_change") this.state = undefined;
			if (entry.type === "custom" && entry.customType === CODEX_CACHE_ENTRY) this.accept(entry.data);
		}
	}

	accept(value: unknown): void {
		if (!checkpoint(value)) { this.state = undefined; return; }
		const previous = this.state;
		if (value.start) {
			this.state = value.effort === value.baseline ? { last: value, updates: [] } : undefined;
			return;
		}
		// 缺失首个检查点时不能猜测旧更新的位置，下一次请求建立新基线。
		if (!previous || previous.last.lineage !== value.lineage) { this.state = undefined; return; }
		if (previous.last.baseline !== value.baseline || previous.last.scope !== value.scope || value.count < previous.last.count ||
			(value.count === previous.last.count && value.hash !== previous.last.hash)) {
			this.state = undefined;
			return;
		}
		this.state = {
			last: value,
			updates: previous.last.effort === value.effort ? previous.updates : [...previous.updates, { at: value.count, effort: value.effort }],
		};
	}

	reset(): Reset | undefined {
		return this.state ? { version: 1, reset: true } : undefined;
	}

	plan(payload: unknown): Plan | undefined {
		if (!object(payload) || !Array.isArray(payload.input) || !object(payload.reasoning) || !effort(payload.reasoning.effort)) return undefined;
		const input: unknown[] = payload.input;
		// 已有原生/其他扩展的更新时不叠加适配；清除旧状态，防止以后重放错误位置。
		if (input.some((item) => object(item) && item.type === "configuration_update")) {
			const reset = this.reset();
			return reset ? { payload, checkpoint: reset } : undefined;
		}
		const selected = payload.reasoning.effort;
		const { input: _input, reasoning: _reasoning, prompt_cache_key: _key, ...other } = payload;
		// 路由键在 fork 后会变化，但不是模型输入；其余请求设置变化则保守重建基线。
		const { effort: _effort, ...reasoning } = payload.reasoning;
		const scope = hash({ ...other, reasoning });
		const previous = this.state;
		const extendsPrevious = previous && scope === previous.last.scope && input.length >= previous.last.count &&
			hash(input.slice(0, previous.last.count)) === previous.last.hash;
		const next: Checkpoint = {
			version: 1, start: !extendsPrevious, lineage: extendsPrevious ? previous.last.lineage : randomUUID(), scope,
			baseline: extendsPrevious ? previous.last.baseline : selected, effort: selected, count: input.length, hash: hash(input),
		};
		const updates = extendsPrevious ? [...previous.updates] : [];
		if (extendsPrevious && selected !== previous.last.effort) updates.push({ at: input.length, effort: selected });
		const outgoing: unknown[] = [];
		let cursor = 0;
		for (const update of updates) {
			outgoing.push(...input.slice(cursor, update.at), { type: "configuration_update", reasoning: { effort: update.effort } });
			cursor = update.at;
		}
		outgoing.push(...input.slice(cursor));
		const unchanged = previous && next.lineage === previous.last.lineage && next.count === previous.last.count &&
			next.hash === previous.last.hash && next.effort === previous.last.effort;
		return {
			payload: { ...payload, reasoning: { ...payload.reasoning, effort: next.baseline }, input: outgoing },
			...(!unchanged ? { checkpoint: next } : {}),
		};
	}
}

export function registerCodexCache(pi: ExtensionAPI, enabled: () => boolean): { reset: () => void } {
	const history = new CodexCacheHistory();
	const save = (value: Checkpoint | Reset) => {
		// 必须先持久化再修改内存或返回请求；写入失败交给 Pi 的扩展错误边界处理。
		pi.appendEntry(CODEX_CACHE_ENTRY, value);
		history.accept(value);
	};
	const reset = () => { const value = history.reset(); if (value) save(value); };
	pi.on("session_start", (_event, ctx) => history.restore(ctx.sessionManager.getBranch()));
	pi.on("session_tree", (_event, ctx) => history.restore(ctx.sessionManager.getBranch()));
	pi.on("session_compact", reset);
	pi.on("model_select", reset);
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled() || ctx.signal?.aborted || !supportsCodexCache(ctx.model) || !object(event.payload) ||
			event.payload.model !== ctx.model?.id || event.payload.prompt_cache_key !== ctx.sessionManager.getSessionId()) return;
		// 会话路由键排除了选择器、摘要和压缩等直接请求；只处理当前 Agent 请求。
		const plan = history.plan(event.payload);
		if (!plan) return;
		if (plan.checkpoint) save(plan.checkpoint);
		return plan.payload;
	});
	return { reset };
}
