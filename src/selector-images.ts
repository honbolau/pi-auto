import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage, type SessionEntry } from "@earendil-works/pi-coding-agent";

export type ImageWarning = "unsupported" | "invalid_image" | "image_limits" | "request_limits";
export type PreparedImages = { images: ImageContent[]; warning?: ImageWarning };
// 仅缓存附件对象的处理结果；不保留整个历史，不把像素或哈希写入会话日志。
const prepared = new WeakMap<ImageContent, Map<boolean, Promise<ImageContent | undefined>>>();
const MIB = 1024 * 1024;

/** 原始标注图配合当前任务最新一次工具截图，不从之前的用户任务借图。 */
export function selectionImages(current: ImageContent[], entries: readonly SessionEntry[], step: boolean): ImageContent[] {
	let latest: ImageContent[] = [];
	if (step) {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type === "compaction" || (entry?.type === "message" && entry.message.role === "user")) break;
			if (entry?.type !== "message" || entry.message.role !== "toolResult") continue;
			const images = entry.message.content.filter((part): part is ImageContent => part.type === "image");
			if (images.length) { latest = images; break; }
		}
	}
	const seen = new Set<string>();
	return [...current, ...latest].filter(image => {
		const key = createHash("sha256").update(image.data).digest("hex");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function normalize(image: ImageContent, jev: boolean): Promise<ImageContent | undefined> {
	const bytes = Buffer.from(image.data, "base64");
	// 解码前后双重限额，避免异常附件导致无界内存占用。
	if (!bytes.length || bytes.length > 16 * MIB || bytes.toString("base64") !== image.data) return;
	const result = await resizeImage(bytes, image.mimeType, {
		maxWidth: jev ? 1568 : 2000, maxHeight: jev ? 1568 : 2000,
		maxBytes: 16 * MIB, jpegQuality: 90,
	});
	if (!result) return;
	// Pi 的缩放器不补边；小图或极端长宽比明确降级，不发必定被服务端拒绝的图。
	if (jev && (result.width < 280 || result.height < 280 || result.width * result.height < 78_400)) return;
	if (result.mimeType !== "image/png" && result.mimeType !== "image/jpeg") return;
	return { type: "image", data: result.data, mimeType: result.mimeType };
}

export async function prepareSelectorImages(
	images: ImageContent[], model: { id: string; input: string[]; inputLimits?: { maxRequestBytes?: number | undefined; images?: { maxPerRequest?: number | undefined } | undefined } | undefined },
	textBytes: number, signal: AbortSignal,
): Promise<PreparedImages> {
	if (!images.length) return { images: [] };
	if (!model.input.includes("image")) return { images: [], warning: "unsupported" };
	const jev = /jev/i.test(model.id);
	const budget = Math.min(model.inputLimits?.maxRequestBytes ?? 32 * MIB, 32 * MIB) - textBytes - 65536;
	const maxImages = model.inputLimits?.images?.maxPerRequest;
	const output: ImageContent[] = [];
	const seen = new Set<string>();
	let encoded = 0, processed = 0;
	for (const image of images) {
		signal.throwIfAborted();
		const key = createHash("sha256").update(image.data).digest("hex");
		if (seen.has(key)) continue;
		seen.add(key);
		if (image.data.length > Math.ceil(16 * MIB / 3) * 4) return { images: [], warning: "image_limits" };
		let cache = prepared.get(image);
		if (!cache) { cache = new Map(); prepared.set(image, cache); }
		let pending = cache.get(jev);
		if (!pending) { pending = normalize(image, jev); cache.set(jev, pending); }
		let ready: ImageContent | undefined;
		// 解码失败只降级此处的选档，不能泄漏底层错误正文或中断主任务。
		try { ready = await pending; } catch { return { images: [], warning: "invalid_image" }; }
		signal.throwIfAborted();
		if (!ready) return { images: [], warning: "invalid_image" };
		encoded += ready.data.length;
		// 处理后按 RGBA 及最大边长保守计费，给服务端重编码留足空间。
		processed += jev ? 1568 * 1568 * 4 : 2000 * 2000 * 4;
		if (encoded > budget || processed > 32 * MIB || (maxImages !== undefined && output.length >= maxImages)) {
			return { images: [], warning: "request_limits" };
		}
		output.push(ready);
	}
	return { images: output };
}
