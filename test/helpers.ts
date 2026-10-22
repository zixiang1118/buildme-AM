import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { PiharnessProfile } from "../src/contracts.js";

export async function tempWorkspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "piharness-"));
	// DSH profiles install plugin dependencies beside the profile. Tests use the
	// repository dependency generation through the same node_modules position.
	await symlink(resolve("node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeProfile(dir: string, profile: PiharnessProfile): Promise<string> {
	const path = join(dir, "profile.json");
	await writeFile(path, JSON.stringify(profile, null, 2));
	return path;
}

/** File symlinks need a Windows privilege; directory junctions do not. */
export async function supportsFileSymlinks(): Promise<boolean> {
	const parent = resolve(tmpdir()), probe = await mkdtemp(join(parent, "piharness-symlink-probe-"));
	try {
		await writeFile(join(probe, "source.txt"), "probe");
		try { await symlink("source.txt", join(probe, "link.txt"), "file"); return true; }
		catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
	} finally {
		assert.equal(dirname(resolve(probe)), parent); assert.ok(basename(probe).startsWith("piharness-symlink-probe-"));
		await rm(probe, { recursive: true, force: true });
	}
}
