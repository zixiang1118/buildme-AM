import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { httpUrl, FormError } from "./validation.js";
export class RemoteError extends FormError {
  constructor(message = "链接解析失败，请手动填写标题") {
    super(message);
  }
}
export interface RemoteResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
  url: string;
}
export interface FetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  truncate?: boolean;
}
export type Resolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;
export type Transport = (
  url: URL,
  address: { address: string; family: number },
  options: Required<FetchOptions>,
  signal: AbortSignal,
) => Promise<RemoteResponse>;
const requestPinned: Transport = (url, address, options, signal) =>
  new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        signal,
        headers: {
          "User-Agent": "BuildMeCommunity/0.1",
          Accept: "*/*",
          "Accept-Encoding": "identity",
        },
        lookup: (_host, _opts, cb) => cb(null, address.address, address.family),
      },
      (response) => {
        const headers: Record<string, string | undefined> = {};
        for (const key of ["location", "content-type"])
          headers[key] = String(response.headers[key] ?? "");
        if (response.statusCode! >= 300 && response.statusCode! < 400) {
          response.destroy();
          resolve({
            status: response.statusCode!,
            headers,
            body: Buffer.alloc(0),
            url: url.href,
          });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size + chunk.length > options.maxBytes) {
            if (options.truncate) {
              chunks.push(chunk.subarray(0, options.maxBytes - size));
              resolve({
                status: response.statusCode!,
                headers,
                body: Buffer.concat(chunks),
                url: url.href,
              });
              response.destroy();
            } else response.destroy(new RemoteError("远程文件超过大小限制"));
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            headers,
            body: Buffer.concat(chunks),
            url: url.href,
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
export class SafeFetcher {
  constructor(
    private resolver: Resolver = (host) => lookup(host, { all: true }),
    private transport: Transport = requestPinned,
  ) {}
  async validate(raw: string, timeoutMs = 4000) {
    const url = new URL(httpUrl(raw));
    if (url.port && !["80", "443"].includes(url.port))
      throw new RemoteError("不允许解析非 80/443 端口");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let timer: ReturnType<typeof setTimeout>;
    try {
      const addresses = await Promise.race([
        this.resolver(hostname),
        new Promise<never>((_r, reject) => {
          timer = setTimeout(
            () => reject(new RemoteError("链接解析超时")),
            timeoutMs,
          );
        }),
      ]);
      if (
        !addresses.length ||
        addresses.some((a) => ipaddr.process(a.address).range() !== "unicast")
      )
        throw new RemoteError("不允许解析内网、回环或保留地址");
    } catch (error) {
      if (error instanceof FormError) throw error;
      throw new RemoteError();
    } finally {
      clearTimeout(timer!);
    }
  }
  async get(raw: string, input: FetchOptions = {}): Promise<RemoteResponse> {
    let url = new URL(httpUrl(raw));
    const options = {
      maxBytes: input.maxBytes ?? 512 * 1024,
      timeoutMs: input.timeoutMs ?? 4000,
      truncate: input.truncate ?? false,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      for (let hop = 0; hop <= 3; hop++) {
        if (url.port && !["80", "443"].includes(url.port))
          throw new RemoteError("不允许解析非 80/443 端口");
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = ipaddr.isValid(hostname)
          ? [
              {
                address: hostname,
                family: ipaddr.parse(hostname).kind() === "ipv6" ? 6 : 4,
              },
            ]
          : await Promise.race([
              this.resolver(hostname),
              new Promise<never>((_r, reject) =>
                controller.signal.addEventListener(
                  "abort",
                  () => reject(new RemoteError("链接解析超时，请手动填写标题")),
                  { once: true },
                ),
              ),
            ]);
        if (
          !addresses.length ||
          addresses.some((a) => ipaddr.process(a.address).range() !== "unicast")
        )
          throw new RemoteError("不允许解析内网、回环或保留地址");
        controller.signal.throwIfAborted();
        const response = await this.transport(
          url,
          addresses[0],
          options,
          controller.signal,
        );
        if (response.status >= 300 && response.status < 400) {
          if (hop === 3) throw new RemoteError("链接跳转次数过多");
          url = new URL(httpUrl(new URL(response.headers.location!, url).href));
          continue;
        }
        if (response.status < 200 || response.status >= 300)
          throw new RemoteError();
        return response;
      }
      throw new RemoteError();
    } catch (error) {
      if (error instanceof FormError) throw error;
      throw new RemoteError(
        controller.signal.aborted
          ? "链接解析超时，请手动填写标题"
          : "链接暂时无法访问，请手动填写标题",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
