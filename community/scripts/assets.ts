import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
mkdirSync("public/fonts", { recursive: true });
for (const [font, weights] of [
  ["schibsted-grotesk", [400, 500, 600, 700]],
  ["jetbrains-mono", [400, 500, 600]],
] as const) {
  for (const weight of weights)
    {
      const data=readFileSync(`node_modules/@fontsource/${font}/files/${font}-latin-${weight}-normal.woff2`);
      const hash=createHash('sha256').update(data).digest('hex').slice(0,12);
      writeFileSync(`public/fonts/${font}-latin-${weight}-normal.${hash}.woff2`,data);
    }
  cpSync(
    `node_modules/@fontsource/${font}/LICENSE`,
    `public/fonts/${font}-LICENSE`,
  );
}
cpSync("src/db/migrations", "dist/src/db/migrations", { recursive: true });
