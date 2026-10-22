import { it, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { fixture, browser } from "./helpers.js";
import { SafeFetcher, type Transport } from "../src/lib/remote.js";
it("P-1 本地oEmbed桩两秒内返回标题，缩略图存到本站并缓存24小时", async () => {
  const png = await sharp({
    create: { width: 100, height: 60, channels: 3, background: "#c4582f" },
  })
    .png()
    .toBuffer();
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (req.url?.startsWith("/oembed")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          title: "从零理解 Agent",
          thumbnail_url: "https://images.test/cover.png",
        }),
      );
    } else {
      res.setHeader("Content-Type", "image/png");
      res.end(png);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport: Transport = async (url, _address, options, signal) => {
    const response = await fetch(base + url.pathname + url.search, { signal });
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBeLessThanOrEqual(options.maxBytes);
    return {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "" },
      body,
      url: url.href,
    };
  };
  const remote = new SafeFetcher(
    async () => [{ address: "8.8.8.8", family: 4 }],
    transport,
  );
  const f = await fixture({ remote });
  const b = browser(f.app);
  await b.login();
  await b.request("/new");
  const start = performance.now();
  const response = await b.post(
    "/links/resolve",
    { link: "https://youtube.com/watch?v=demo" },
    true,
  );
  expect(response.status).toBe(200);
  expect(performance.now() - start).toBeLessThan(2000);
  const info = (await response.json()) as {
    title: string;
    thumbnail: string;
    source: string;
  };
  expect(info.title).toBe("从零理解 Agent");
  expect(info.thumbnail).toMatch(/^\/media\//);
  expect(info.source).toBe("YouTube");
  await b.post(
    "/links/resolve",
    { link: "https://youtube.com/watch?v=demo" },
    true,
  );
  expect(calls).toBe(2);
  const created = await b.post(
    "/new",
    {
      title: info.title,
      body: "值得一起看看",
      category: "1",
      link: "https://youtube.com/watch?v=demo",
    },
    true,
  );
  expect(created.status).toBe(201);
  const result = (await created.json()) as { html: string; url: string };
  expect(result.html).toContain(info.thumbnail);
  expect(result.html).not.toContain('src="https://');
  const id = Number(result.url.match(/\/p\/(\d+)/)![1]);
  await b.request(`/go/${id}`);
  await b.request(`/go/${id}`);
  expect(f.db.prepare("SELECT clicks FROM posts WHERE id=?").get(id)).toEqual({
    clicks: 1,
  });
  const duplicate = (await (
    await b.post(
      "/links/resolve",
      { link: "https://youtube.com/watch?v=demo" },
      true,
    )
  ).json()) as { duplicate: { id: number } };
  expect(duplicate.duplicate.id).toBe(id);
  await f.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
