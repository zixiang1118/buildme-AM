import type { ImageContent } from "@earendil-works/pi-ai";

export const MAX_CHAT_IMAGES = 8;
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

export function rasterMime(data: Uint8Array): ImageContent["mimeType"] | undefined {
	const bytes = Buffer.from(data);
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return undefined;
}

/** Validate and snapshot raster inputs before either engine admits a user turn. */
export function parseChatImages(value: unknown): ImageContent[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_CHAT_IMAGES) throw new Error("一次最多发送 8 张图片。");
	return value.map((image: unknown) => {
		if (!image || typeof image !== "object") throw new Error("图片附件格式不正确。");
		const input = image as Record<string, unknown>;
		// Repeated capture groups can overflow V8's regexp stack on camera-sized
		// images. A character-class check plus canonical decoding stays bounded.
		if (input.type !== "image" || typeof input.data !== "string" || !input.data || input.data.length % 4 !== 0 || input.data.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.data)) throw new Error("图片附件不是有效的 Base64 数据，或超过 10 MB。");
		const bytes = Buffer.from(input.data, "base64");
		if (bytes.toString("base64") !== input.data) throw new Error("图片附件不是有效的 Base64 数据。");
		const mimeType = rasterMime(bytes);
		if (!mimeType || input.mimeType !== mimeType || bytes.length > MAX_CHAT_IMAGE_BYTES) throw new Error("图片附件的格式与内容不一致，仅支持 PNG、JPEG、WebP 和 GIF。");
		return { type: "image", data: input.data, mimeType };
	});
}
