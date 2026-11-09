import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clipboardImages, type ClipboardImageCache } from "../src/clipboard-images.ts";
const signal = new AbortController().signal;
describe("TUI clipboard paths", () => {
	it("reads a current Pi clipboard path once", async () => {
		const file = join(tmpdir(), "pi-clipboard-" + randomUUID() + ".png");
		try {
			await writeFile(file, "image fixture");
			const result = await clipboardImages(file + " fix this " + file, signal);
			expect(result.failed).toBe(false);
			expect(result.images).toEqual([{ type: "image", mimeType: "image/png", data: Buffer.from("image fixture").toString("base64") }]);
		} finally { await rm(file, { force: true }); }
	});
	it("reuses the same attachment object within a task, invalidating changed and removed files", async () => {
		const file = join(tmpdir(), "pi-clipboard-" + randomUUID() + ".png");
		const cache: ClipboardImageCache = new Map();
		try {
			await writeFile(file, "first");
			const first = await clipboardImages(file, signal, cache);
			const reused = await clipboardImages(file, signal, cache);
			expect(reused.images[0]).toBe(first.images[0]);
			await writeFile(file, "changed screenshot");
			const changed = await clipboardImages(file, signal, cache);
			expect(changed.images[0]).not.toBe(first.images[0]);
			expect(changed.images[0]?.data).toBe(Buffer.from("changed screenshot").toString("base64"));
			// 新任务用独立缓存，不跨任务复用对象和缩放结果。
			expect((await clipboardImages(file, signal, new Map())).images[0]).not.toBe(changed.images[0]);
			await rm(file);
			expect(await clipboardImages(file, signal, cache)).toEqual({ images: [], failed: true });
		} finally { await rm(file, { force: true }); }
	});
	it("does not reuse a cached file after it becomes a symlink", async () => {
		const file = join(tmpdir(), "pi-clipboard-" + randomUUID() + ".png");
		const cache: ClipboardImageCache = new Map();
		try {
			await writeFile(file, "image");
			await clipboardImages(file, signal, cache);
			await rm(file);
			await symlink("/etc/passwd", file);
			expect(await clipboardImages(file, signal, cache)).toEqual({ images: [], failed: true });
		} finally { await rm(file, { force: true }); }
	});
	it("ignores arbitrary files and clipboard-named files outside the temp root", async () => {
		const dir = await mkdtemp(join(tmpdir(), "clipboard-test-"));
		try {
			const file = join(dir, "pi-clipboard-" + randomUUID() + ".png");
			await writeFile(file, "private");
			expect((await clipboardImages(file + " /etc/passwd", signal)).images).toEqual([]);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	it("rejects symlinks and reports missing screenshots", async () => {
		const file = join(tmpdir(), "pi-clipboard-" + randomUUID() + ".png");
		try {
			await symlink("/etc/passwd", file);
			expect(await clipboardImages(file, signal)).toEqual({ images: [], failed: true });
		} finally { await rm(file, { force: true }); }
		expect((await clipboardImages(file, signal)).failed).toBe(true);
	});
});
