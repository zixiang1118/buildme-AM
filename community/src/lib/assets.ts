import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const hashes=new Map<string,string>();
export function asset(name: string) {
  if(hashes.has(name))return hashes.get(name)!;
  const hash = createHash("sha256")
    .update(readFileSync(resolve("public", name)))
    .digest("hex")
    .slice(0, 12);
  const at = name.lastIndexOf(".");
  const url=`/assets/${name.slice(0, at)}.${hash}${name.slice(at)}`;
  hashes.set(name,url);return url;
}
