import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { readConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { ensureNameAvailable, hashPassword } from "../src/lib/auth.js";
import { usernameKey, validatePassword } from "../src/lib/validation.js";
const config = readConfig(),
  db = openDb(join(config.dataDir, "community.sqlite"));
let hidden = false;
const output = new Writable({
  write(chunk, _encoding, done) {
    if (!hidden) stdout.write(chunk);
    done();
  },
});
const rl = createInterface({ input: stdin, output, terminal: true });
try {
  const name = (await rl.question("管理员用户名：")).trim();
  ensureNameAvailable(db, name);
  stdout.write("管理员密码（不显示）：");
  hidden = true;
  const password = await rl.question("");
  hidden = false;
  stdout.write("\n");
  validatePassword(password);
  db.prepare(
    "INSERT INTO users(username,username_key,password_hash,role,created_at,first_post_approved) VALUES (?,?,?,'admin',?,1)",
  ).run(name, usernameKey(name), await hashPassword(password), Date.now());
  console.log("管理员已创建。登录后可在 /admin 生成邀请码。");
} finally {
  rl.close();
  db.close();
}
