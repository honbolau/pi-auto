import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clipboardImages } from "../src/clipboard-images.ts";
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
