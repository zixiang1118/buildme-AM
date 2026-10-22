import { rm } from "node:fs/promises";
export default async function teardown() {
  await rm(process.env.COMMUNITY_BROWSER_DATA_DIR!, {
    recursive: true,
    force: true,
  });
}
