import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import OSS from "ali-oss";
import type { Config } from "../config.js";
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  url(key: string): string;
}
export class LocalStorage implements Storage {
  constructor(private directory: string) {}
  async put(key: string, data: Buffer) {
    const path = join(this.directory, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  async get(key: string) {
    return readFile(join(this.directory, key));
  }
  async remove(key: string) {
    await rm(join(this.directory, key), {force:true});
  }
  url(key: string) {
    return `/media/${key}`;
  }
}
export class OssStorage implements Storage {
  private client: OSS;
  constructor(private config: Config) {
    this.client = new OSS({
      region: config.ossRegion,
      bucket: config.ossBucket,
      accessKeyId: config.ossAccessKeyId,
      accessKeySecret: config.ossAccessKeySecret,
      secure: true,
    });
  }
  async put(key: string, data: Buffer, contentType: string) {
    await this.client.put(key, data, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  async get(key: string) {
    return Buffer.from((await this.client.get(key)).content);
  }
  async remove(key: string) {
    await this.client.delete(key);
  }
  url(key: string) {
    return `${this.config.ossPublicUrl.replace(/\/$/, "")}/${key}`;
  }
}
export function createStorage(config: Config): Storage {
  return config.storageDriver === "oss"
    ? new OssStorage(config)
    : new LocalStorage(join(config.dataDir, "media"));
}
