import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OAuthCredentials, OAuthProviderInterface } from "@earendil-works/pi-ai/compat";
import { ProfileManager } from "../src/manager.js";
import { Vault } from "../src/vault.js";

const credential = (access: string, expires = Date.now() + 60_000): OAuthCredentials => ({ refresh: `r-${access}`, access, expires, tenant: "kept" });

function setup() {
  const mirror = new Map<string, { type: "oauth" } & OAuthCredentials>();
  const runtime = { model: "anthropic/old", failModel: false };
  const provider: OAuthProviderInterface = {
    id: "anthropic", name: "Anthropic", login: async () => credential("login"),
    refreshToken: async value => credential(`${value.access}-fresh`), getApiKey: value => value.access,
  };
  return { mirror, provider, runtime, adapter: {
    getCredential: (id: string) => mirror.get(id), setCredential: (id: string, value: { type: "oauth" } & OAuthCredentials) => { mirror.set(id, value); },
    removeCredential: (id: string) => { mirror.delete(id); }, getModel: () => runtime.model,
    setModel: async (value: string) => runtime.failModel ? false : (runtime.model = value, true), models: (id: string) => [`${id}/new`],
  }};
}

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
  const env = setup();
  return { ...env, manager: new ProfileManager(new Vault(join(dir, "vault.json")), env.adapter, new Map([[env.provider.id, env.provider]])) };
}

test("bootstrap imports an existing OAuth mirror once", async () => {
  const env = await manager();
  env.mirror.set("anthropic", { type: "oauth", ...credential("existing") });
  await env.manager.bootstrap();
  await env.manager.bootstrap();
  const profiles = (await env.manager.state()).providers.anthropic?.profiles;
  assert.deepEqual(Object.keys(profiles ?? {}), ["Default"]);
  assert.equal(profiles?.Default?.credential.tenant, "kept");
});

test("activation updates mirror, model, default, and status", async () => {
  const env = await manager();
  await env.manager.capture("anthropic", credential("saved"), "Work");
  await env.manager.activate("anthropic", "Work", "anthropic/new");
  assert.equal(env.mirror.get("anthropic")?.access, "saved");
  assert.equal(env.runtime.model, "anthropic/new");
  assert.equal((await env.manager.state()).providers.anthropic?.defaultProfile, "Work");
  assert.equal(await env.manager.status("anthropic"), "anthropic/Work");
});

test("failed activation restores the prior mirror and model", async () => {
  const env = await manager();
  env.mirror.set("anthropic", { type: "oauth", ...credential("prior") });
  await env.manager.capture("anthropic", credential("saved"), "Work");
  env.runtime.failModel = true;
  await assert.rejects(env.manager.activate("anthropic", "Work", "anthropic/new"), /previous selection was restored/);
  assert.equal(env.mirror.get("anthropic")?.access, "prior");
  assert.equal(env.runtime.model, "anthropic/old");
});

test("rename, deletion, and reconciliation preserve explicit outcomes", async () => {
  const env = await manager();
  await env.manager.capture("anthropic", credential("one"), "One");
  await env.manager.capture("anthropic", credential("two"), "Two");
  await env.manager.rename("anthropic", "Two", "Work");
  await env.manager.activate("anthropic", "Work", "anthropic/new");
  assert.equal(await env.manager.delete("anthropic", "Work"), "switched");
  env.mirror.set("anthropic", { type: "oauth", ...credential("external") });
  await env.manager.reconcile("anthropic", "update");
  assert.equal((await env.manager.state()).providers.anthropic?.profiles.One?.credential.access, "external");
  env.mirror.set("anthropic", { type: "oauth", ...credential("new") });
  await env.manager.reconcile("anthropic", "create", "Imported");
  env.mirror.set("anthropic", { type: "oauth", ...credential("changed") });
  await env.manager.reconcile("anthropic", "restore");
  assert.equal(env.mirror.get("anthropic")?.access, "new");
});

test("delete and Activation are serialized across managers", async () => {
  const env = await manager();
  await env.manager.capture("anthropic", credential("one"), "One");
  await env.manager.capture("anthropic", credential("work"), "Work");
  await env.manager.activate("anthropic", "Work", "anthropic/new");
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const setModel = env.adapter.setModel;
  let pauseOnce = true;
  env.adapter.setModel = async value => {
    if (pauseOnce) { pauseOnce = false; entered(); await paused; }
    return setModel(value);
  };
  const deletion = env.manager.delete("anthropic", "Work");
  await started;
  const competing = env.manager.activate("anthropic", "Work", "anthropic/new");
  release();
  assert.equal(await deletion, "switched");
  await assert.rejects(competing, /previous selection was restored/);
  assert.equal(env.mirror.get("anthropic")?.access, "one");
});

test("rejects a stale refresh result", async () => {
  const env = await manager();
  const profileName = await env.manager.capture("anthropic", credential("old", 0), "Work");
  let resolveRefresh!: (value: OAuthCredentials) => void;
  let started!: () => void;
  const refreshStarted = new Promise<void>(resolve => { started = resolve; });
  env.provider.refreshToken = async () => new Promise(resolve => { resolveRefresh = resolve; started(); });
  const refreshing = env.manager.refreshAll();
  await refreshStarted;
  const profile = (await env.manager.state()).providers.anthropic?.profiles[profileName];
  assert.ok(profile);
  await env.manager.vault.updateCredential("anthropic", profile.id, { type: "oauth", ...credential("new") });
  resolveRefresh(credential("stale"));
  await refreshing;
  assert.equal((await env.manager.state()).providers.anthropic?.profiles.Work?.credential.access, "new");
});

test("refresh retains rotation and marks permanent failures without deletion", async () => {
  const env = await manager();
  await env.manager.capture("anthropic", credential("saved", 0), "Work");
  await env.manager.refreshAll();
  assert.equal((await env.manager.state()).providers.anthropic?.profiles.Work?.credential.access, "saved-fresh");
  env.provider.refreshToken = async () => { throw new Error("invalid_grant"); };
  await env.manager.refreshAll();
  assert.equal((await env.manager.state()).providers.anthropic?.profiles.Work?.status, "needs-login");
});
