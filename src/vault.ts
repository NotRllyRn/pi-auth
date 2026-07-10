import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthCredential, CredentialProfile, VaultState } from "./types.js";
import { emptyVault } from "./types.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const clone = <T>(value: T): T => structuredClone(value);

export class Vault {
  readonly path: string;
  private readonly lockPath: string;

  constructor(path: string) {
    this.path = path;
    this.lockPath = `${path}.lock`;
  }

  async read(): Promise<VaultState> {
    return this.withLock(state => state);
  }

  async change<T>(mutate: (state: VaultState) => T | Promise<T>): Promise<T> {
    return this.withLock(async state => ({ result: await mutate(state), write: true }));
  }

  async add(provider: string, name: string, credential: OAuthCredential): Promise<CredentialProfile> {
    return this.change(state => {
      const scoped = state.providers[provider] ??= { profiles: {} };
      if (scoped.profiles[name]) throw new Error(`Profile "${name}" already exists for ${provider}`);
      const profile = { id: randomUUID(), credential: clone(credential), generation: 1, status: "ready", retryCount: 0 } as const;
      scoped.profiles[name] = profile;
      scoped.defaultProfile = name;
      return clone(profile);
    });
  }

  async updateCredential(provider: string, id: string, credential: OAuthCredential): Promise<void> {
    await this.change(state => {
      const profile = this.findById(state, provider, id);
      profile.credential = clone(credential);
      profile.generation++;
      profile.status = "ready";
      profile.retryCount = 0;
      delete profile.nextRetryAt;
    });
  }

  async commitRefresh(provider: string, id: string, generation: number, credential: OAuthCredential): Promise<boolean> {
    return this.change(state => {
      const profile = this.findById(state, provider, id);
      if (profile.generation !== generation) return false;
      profile.credential = clone(credential);
      profile.generation++;
      profile.status = "ready";
      profile.retryCount = 0;
      delete profile.nextRetryAt;
      return true;
    });
  }

  private findById(state: VaultState, provider: string, id: string): CredentialProfile {
    const profile = Object.values(state.providers[provider]?.profiles ?? {}).find(value => value.id === id);
    if (!profile) throw new Error(`Profile not found for ${provider}`);
    return profile;
  }

  private async withLock<T>(operation: (state: VaultState) => T | { result: T; write: true } | Promise<T | { result: T; write: true }>): Promise<T> {
    await this.acquire();
    try {
      const state = await this.load();
      const outcome = await operation(state);
      if (typeof outcome === "object" && outcome !== null && "write" in outcome) {
        await this.persist(state);
        return outcome.result;
      }
      return outcome;
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const age = Date.now() - (await stat(this.lockPath)).mtimeMs;
          if (age > 300_000) await rm(this.lockPath, { recursive: true, force: true });
          else await sleep(50);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        }
      }
    }
    throw new Error("Profile Vault is busy; try again");
  }

  private async load(): Promise<VaultState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!value || typeof value !== "object" || !("providers" in value)) throw new Error("invalid vault");
      const state = value as VaultState;
      if (state.version !== 1) state.version = 1;
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyVault();
      await rename(this.path, `${this.path}.corrupt`).catch(async renameError => {
        if ((renameError as NodeJS.ErrnoException).code === "EEXIST") {
          await rm(`${this.path}.corrupt`, { force: true });
          await rename(this.path, `${this.path}.corrupt`);
        } else throw renameError;
      });
      return emptyVault();
    }
  }

  private async persist(state: VaultState): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
