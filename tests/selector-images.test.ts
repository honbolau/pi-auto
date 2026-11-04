import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { prepareSelectorImages, selectionImages } from "../src/selector-images.ts";
vi.mock("@earendil-works/pi-coding-agent", () => ({ resizeImage: vi.fn() }));
const model = { id: "jev-latest", input: ["text", "image"] };
const image = () => ({ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" });
const signal = new AbortController().signal;
describe("selector image preparation", () => {
	it("normalizes and deduplicates without changing the source", async () => {
		vi.mocked(resizeImage).mockResolvedValue({ data: "bmV3", mimeType: "image/jpeg", width: 1000, height: 500, originalWidth: 2000, originalHeight: 1000, wasResized: true });
		const source = image();
		const result = await prepareSelectorImages([source, image()], model, 100, signal);
		expect(result.images).toEqual([{ type: "image", data: "bmV3", mimeType: "image/jpeg" }]);
		expect(source.data).toBe("aGVsbG8=");
		expect(resizeImage).toHaveBeenLastCalledWith(expect.any(Uint8Array), "image/png", expect.objectContaining({ maxWidth: 1568 }));
	});
	it("explicitly degrades tiny or undecodable images", async () => {
		vi.mocked(resizeImage).mockResolvedValue(null);
		expect(await prepareSelectorImages([image()], model, 0, signal)).toEqual({ images: [], warning: "invalid_image" });
	});
	it("reports request budget and unsupported input without sending partial groups", async () => {
		expect((await prepareSelectorImages([image()], { ...model, input: ["text"] }, 0, signal)).warning).toBe("unsupported");
		vi.mocked(resizeImage).mockResolvedValue({ data: "bmV3", mimeType: "image/png", width: 300, height: 300, originalWidth: 300, originalHeight: 300, wasResized: false });
		expect((await prepareSelectorImages([image()], model, 32 * 1024 * 1024, signal)).warning).toBe("request_limits");
	});
	it("never borrows previous-task images", () => {
		expect(selectionImages([image(), image()], [], false)).toHaveLength(1);
	});
	it("uses only the latest current-task tool image and stops at user boundaries", () => {
		const old = { ...image(), data: "b2xk" }, latest = { ...image(), data: "bmV3" };
		const tool = (photo: typeof old) => ({ type: "message", message: { role: "toolResult", content: [photo] } }) as unknown as SessionEntry;
		const user = { type: "message", message: { role: "user", content: "new task" } } as unknown as SessionEntry;
		expect(selectionImages([image()], [tool(old), user, tool(latest)], true)).toEqual([image(), latest]);
		expect(selectionImages([image()], [tool(old), user], true)).toEqual([image()]);
		expect(selectionImages([image()], [tool(latest)], false)).toEqual([image()]);
	});
	it("honors cancellation", async () => {
		const controller = new AbortController(); controller.abort();
		await expect(prepareSelectorImages([image()], model, 0, controller.signal)).rejects.toThrow();
	});
});
