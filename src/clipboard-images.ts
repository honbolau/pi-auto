import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";

/** 仅解析 Pi 自己生成的临时截图名，不将任意文件路径自动上传给选档提供商。 */
export async function clipboardImages(prompt: string, signal: AbortSignal): Promise<{ images: ImageContent[]; failed: boolean }> {
	const images: ImageContent[] = [];
	let failed = false, total = 0;
	const paths = new Set(prompt.match(/[^\s"'`<>]*pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)/gi) ?? []);
	if (!paths.size) return { images, failed };
	const root = await realpath(tmpdir());
	for (const path of paths) {
		signal.throwIfAborted();
		if (!isAbsolute(path) || !/^pi-clipboard-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(png|jpe?g|webp|gif)$/i.test(basename(path))) continue;
		try {
			// 允许 macOS /var 与 /private/var 别名，但拒绝跳出临时目录及文件符号链接。
			if (await realpath(dirname(path)) !== root) continue;
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024 || total + stat.size > 32 * 1024 * 1024) {
					failed = true; continue;
				}
				// 定长读取避免文件增长造成无界分配；变化中的截图不作为可靠输入。
				const bytes = Buffer.alloc(stat.size + 1);
				const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
				if (bytesRead !== stat.size) { failed = true; continue; }
				const extension = basename(path).split(".").pop()?.toLowerCase();
				images.push({ type: "image", data: bytes.subarray(0, bytesRead).toString("base64"), mimeType: "image/" + (extension === "jpg" ? "jpeg" : extension) });
				total += bytesRead;
			} finally { await file.close(); }
		} catch {
			// 缺失、权限或链接错误统一提示，不记录路径或底层错误正文。
			failed = true;
		}
	}
	signal.throwIfAborted();
	return { images, failed };
}
