import type { OAuthCredentials, OAuthProviderInterface } from "@earendil-works/pi-ai/compat";
import type { CredentialProfile, OAuthCredential, VaultState } from "./types.js";
import type { Vault } from "./vault.js";

export interface PiAdapter {
  getCredential(provider: string): OAuthCredential | undefined;
  setCredential(provider: string, credential: OAuthCredential): void;
  removeCredential(provider: string): void;
  getModel(): string | undefined;
  setModel(model: string): Promise<boolean>;
  models(provider: string): string[];
}

const oauth = (credential: OAuthCredentials): OAuthCredential => ({ type: "oauth", ...credential });
const sameCredential = (left: OAuthCredential | undefined, right: OAuthCredential | undefined) =>
  left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
const isPermanent = (error: unknown) => /invalid_grant|unauthorized|forbidden|\b40[013]\b/i.test(error instanceof Error ? error.message : String(error));

export class ProfileManager {
  constructor(
    readonly vault: Vault,
    private readonly pi: PiAdapter,
    private readonly providers: Map<string, OAuthProviderInterface>,
    private readonly now = Date.now,
  ) {}

  state(): Promise<VaultState> { return this.vault.read(); }
  supportedProviders(): string[] { return [...this.providers.keys()].sort((left, right) => left.localeCompare(right)); }
  models(provider: string): string[] { return this.pi.models(provider); }

  async bootstrap(): Promise<void> {
    const state = await this.state();
    for (const provider of this.supportedProviders()) {
      const current = this.pi.getCredential(provider);
      if (current?.type === "oauth" && !state.providers[provider]) await this.vault.add(provider, "Default", current);
    }
  }

  async capture(provider: string, credentials: OAuthCredentials, requestedName?: string): Promise<string> {
    this.requireProvider(provider);
    const state = await this.state();
    const scoped = state.providers[provider];
    const base = requestedName?.trim() || "Profile";
    const name = requestedName?.trim() ? this.validateName(base) : this.uniqueName(scoped?.profiles ?? {}, base);
    await this.vault.add(provider, name, oauth(credentials));
    return name;
  }

  async activate(provider: string, name: string, model: string): Promise<void> {
    this.requireProvider(provider);
    if (!this.pi.models(provider).includes(model)) throw new Error("Selected model is not compatible with this provider");
    let beforeCredential: OAuthCredential | undefined;
    let beforeModel: string | undefined;
    try {
      await this.vault.change(async state => {
        beforeCredential = this.pi.getCredential(provider);
        beforeModel = this.pi.getModel();
        const scoped = state.providers[provider];
        const profile = scoped?.profiles[name];
        if (!profile) throw new Error("Profile not found");
        this.pi.setCredential(provider, profile.credential);
        if (!await this.pi.setModel(model)) throw new Error("model selection failed");
        scoped.defaultProfile = name;
        scoped.model = model;
      });
    } catch {
      beforeCredential ? this.pi.setCredential(provider, beforeCredential) : this.pi.removeCredential(provider);
      if (beforeModel) await this.pi.setModel(beforeModel);
      throw new Error("Activation failed; the previous selection was restored");
    }
  }

  async rename(provider: string, from: string, requestedName: string): Promise<void> {
    const to = this.validateName(requestedName.trim());
    await this.vault.change(state => {
      const scoped = state.providers[provider];
      const profile = scoped?.profiles[from];
      if (!profile) throw new Error("Profile not found");
      if (scoped.profiles[to]) throw new Error(`Profile "${to}" already exists for ${provider}`);
      scoped.profiles[to] = profile;
      delete scoped.profiles[from];
      if (scoped.defaultProfile === from) scoped.defaultProfile = to;
    });
  }

  async delete(provider: string, name: string): Promise<"deleted" | "switched" | "detached"> {
    let beforeCredential: OAuthCredential | undefined;
    let beforeModel: string | undefined;
    let result: "deleted" | "switched" | "detached" = "deleted";
    try {
      await this.vault.change(async state => {
        beforeCredential = this.pi.getCredential(provider);
        beforeModel = this.pi.getModel();
        const scoped = state.providers[provider];
        const profile = scoped?.profiles[name];
        if (!profile) throw new Error("Profile not found");
        const active = sameCredential(this.pi.getCredential(provider), profile.credential);
        const replacement = Object.keys(scoped.profiles).find(candidate => candidate !== name);
        if (active && replacement) {
          const model = scoped.model && this.pi.models(provider).includes(scoped.model) ? scoped.model : this.pi.models(provider)[0];
          if (!model) throw new Error("No compatible model is available");
          const nextProfile = scoped.profiles[replacement];
          if (!nextProfile) throw new Error("Replacement profile not found");
          this.pi.setCredential(provider, nextProfile.credential);
          if (!await this.pi.setModel(model)) throw new Error("model selection failed");
          scoped.defaultProfile = replacement;
          result = "switched";
        } else if (active) {
          this.pi.removeCredential(provider);
          result = "detached";
        }
        delete scoped.profiles[name];
        if (!Object.keys(scoped.profiles).length) delete state.providers[provider];
      });
      return result;
    } catch {
      beforeCredential ? this.pi.setCredential(provider, beforeCredential) : this.pi.removeCredential(provider);
      if (beforeModel) await this.pi.setModel(beforeModel);
      throw new Error("Deletion failed; the previous selection was restored");
    }
  }

  async reconcile(provider: string, action: "update" | "create" | "restore", name?: string): Promise<void> {
    const mirror = this.pi.getCredential(provider);
    const state = await this.state();
    const scoped = state.providers[provider];
    const selected = scoped?.defaultProfile && scoped.profiles[scoped.defaultProfile];
    if (action === "restore") {
      if (!selected) throw new Error("No Provider Default to restore");
      this.pi.setCredential(provider, selected.credential);
    } else if (action === "update") {
      if (!mirror || !selected) throw new Error("A mirror and Provider Default are required");
      await this.vault.updateCredential(provider, selected.id, mirror);
    } else {
      if (!mirror) throw new Error("No OAuth mirror to save");
      await this.capture(provider, mirror, name);
    }
  }

  async refreshAll(onlyDue = false): Promise<void> {
    const state = await this.state();
    for (const [providerId, scoped] of Object.entries(state.providers)) {
      const provider = this.providers.get(providerId);
      if (!provider) continue;
      for (const profile of Object.values(scoped.profiles)) {
        if (onlyDue && (profile.credential.expires > this.now() + 300_000 || (profile.nextRetryAt ?? 0) > this.now())) continue;
        await this.refresh(provider, profile);
      }
    }
  }

  async status(provider: string): Promise<string> {
    const scoped = (await this.state()).providers[provider];
    const name = scoped?.defaultProfile;
    const profile = name && scoped.profiles[name];
    if (!profile) return `${provider}/signed out`;
    if (!sameCredential(this.pi.getCredential(provider), profile.credential)) return `${provider}/${name} (detached)`;
    return `${provider}/${name}${profile.status === "needs-login" ? " (Needs Login)" : ""}`;
  }

  private async refresh(provider: OAuthProviderInterface, profile: CredentialProfile): Promise<void> {
    try {
      const refreshed = oauth(await provider.refreshToken(profile.credential));
      const committed = await this.vault.commitRefresh(provider.id, profile.id, profile.generation, refreshed);
      if (committed && sameCredential(this.pi.getCredential(provider.id), profile.credential)) this.pi.setCredential(provider.id, refreshed);
    } catch (error) {
      await this.vault.change(state => {
        const current = Object.values(state.providers[provider.id]?.profiles ?? {}).find(value => value.id === profile.id);
        if (!current || current.generation !== profile.generation) return;
        if (isPermanent(error)) current.status = "needs-login";
        else {
          current.status = "retrying";
          current.retryCount = Math.min(current.retryCount + 1, 3);
          current.nextRetryAt = this.now() + ([30_000, 120_000, 600_000][current.retryCount - 1] ?? 600_000);
        }
      });
    }
  }

  private requireProvider(provider: string): void {
    if (!this.providers.has(provider)) throw new Error(`Unsupported OAuth provider: ${provider}`);
  }

  private validateName(name: string): string {
    if (!name || name.length > 64 || /[\\/\0]/.test(name)) throw new Error("Profile names must be 1-64 characters without slashes");
    return name;
  }

  private uniqueName(profiles: Record<string, unknown>, base: string): string {
    if (!profiles[base]) return base;
    for (let suffix = 2; ; suffix++) if (!profiles[`${base} ${suffix}`]) return `${base} ${suffix}`;
  }
}
