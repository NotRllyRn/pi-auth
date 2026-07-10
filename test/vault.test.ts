import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Vault } from "../src/vault.js";

const credential = (access: string) => ({ type: "oauth" as const, refresh: `r-${access}`, access, expires: 10_000 });

test("stores provider-scoped profiles and defaults with private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
  const vault = new Vault(join(dir, "vault.json"));
  await vault.add("anthropic", "Default", credential("a"));
  await vault.add("openai-codex", "Default", credential("b"));

  const state = await vault.read();
  assert.equal(state.providers.anthropic?.defaultProfile, "Default");
  assert.equal(state.providers["openai-codex"]?.profiles.Default?.credential.access, "b");
  assert.equal((await stat(join(dir, "vault.json"))).mode & 0o777, 0o600);
});

test("rejects duplicate names and stale refresh writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
  const vault = new Vault(join(dir, "vault.json"));
  const profile = await vault.add("anthropic", "Default", credential("old"));
  await assert.rejects(vault.add("anthropic", "Default", credential("other")), /already exists/);
  await vault.updateCredential("anthropic", profile.id, credential("new"));
  assert.equal(await vault.commitRefresh("anthropic", profile.id, profile.generation, credential("stale")), false);
  assert.equal((await vault.read()).providers.anthropic?.profiles.Default?.credential.access, "new");
});

test("serializes concurrent profile changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
  const path = join(dir, "vault.json");
  await Promise.all(Array.from({ length: 12 }, (_, index) => new Vault(path).add("anthropic", `Profile ${index}`, credential(String(index)))));
  assert.equal(Object.keys((await new Vault(path).read()).providers.anthropic?.profiles ?? {}).length, 12);
});

test("serializes changes across processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
  const path = join(dir, "vault.json");
  const worker = join(process.cwd(), "test", "lock-worker.ts");
  const run = (prefix: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, path, prefix]);
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`lock worker exited ${code}`)));
  });
  await Promise.all([run("a"), run("b")]);
  assert.equal(Object.keys((await new Vault(path).read()).providers.anthropic?.profiles ?? {}).length, 10);
});

test("recovers malformed data without overwriting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
  const path = join(dir, "vault.json");
  await writeFile(path, "broken", { mode: 0o600 });
  const vault = new Vault(path);
  assert.deepEqual((await vault.read()).providers, {});
  assert.equal(await readFile(`${path}.corrupt`, "utf8"), "broken");
});
