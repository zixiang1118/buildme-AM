import type { HttpBindings } from "@hono/node-server";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Storage } from "./lib/storage.js";
export interface User {
  id: number;
  username: string;
  username_key: string;
  password_hash: string | null;
  github_id: string | null;
  avatar_url: string | null;
  bio: string;
  role: "admin" | "moderator" | "member";
  created_at: number;
  renamed_at: number | null;
  must_change_password: number;
  banned: number;
  muted_until: number | null;
  first_post_approved: number;
  last_home_seen: number;
  last_seen_at: number;
  profile_pending: number;
}
export interface Env {
  Bindings: HttpBindings;
  Variables: {
    config: Config;
    db: Db;
    storage: Storage;
    user: User | null;
    sessionId: string;
    csrf: string;
    ipKey: string;
    theme: string | undefined;
    embed: boolean;
    now: number;
  };
}
export interface Category {
  id: number;
  name: string;
  slug: string;
  description: string;
  color: string;
  position: number;
  active: number;
}
export interface Tag {
  id: number;
  name: string;
  active: number;
}
