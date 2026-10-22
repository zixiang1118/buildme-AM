import sharp from "sharp";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import type { Storage } from "./storage.js";
import { FormError } from "./validation.js";
export async function saveImage(
  db: Db,
  storage: Storage,
  owner: number,
  bytes: Buffer,
  now: number,
) {
  if (bytes.length > 8 * 1024 * 1024) throw new FormError("图片不能超过 8MB");
  const input = sharp(bytes, { limitInputPixels: 40_000_000, animated: true });
  let meta: sharp.Metadata;
  try {
    meta = await input.metadata();
  } catch {
    throw new FormError("请选择有效的 JPG、PNG、WebP 或 GIF 图片");
  }
  if (!["jpeg", "png", "webp", "gif"].includes(meta.format!))
    throw new FormError("只支持 JPG、PNG、WebP 或 GIF");
  if (meta.format === "gif" && bytes.length > 4 * 1024 * 1024)
    throw new FormError("GIF 不能超过 4MB");
  if ((meta.pages ?? 1) > 200) throw new FormError("图片帧数过多");
  const animated = meta.format === "gif";
  const id = randomUUID(),
    key = `${id}.${animated ? "gif" : "webp"}`,
    thumbKey = `${id}-640.webp`;
  let main: Buffer, thumb: Buffer;
  try {
    const processed = input
      .rotate()
      .resize({
        width: 2400,
        height: 2400,
        fit: "inside",
        withoutEnlargement: true,
      });
    main = await (
      animated ? processed.gif() : processed.webp({ quality: 85 })
    ).toBuffer();
    thumb = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 640, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw new FormError("图片无法处理，请换一张图片");
  }
  const mime = animated ? "image/gif" : "image/webp";
  await storage.put(key, main, mime);
  await storage.put(thumbKey, thumb, "image/webp");
  const url = storage.url(key),
    thumbUrl = storage.url(thumbKey);
  db.prepare("INSERT INTO images VALUES (?,?,?,?,?,?,?,?,?)").run(
    id,
    owner,
    key,
    url,
    thumbKey,
    thumbUrl,
    mime,
    main.length,
    now,
  );
  return { id, url, thumbUrl };
}
