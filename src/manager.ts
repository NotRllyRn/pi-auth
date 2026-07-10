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
    const requested = requestedName?.trim();
    if (requested) {
      await this.vault.add(provider, this.validateName(requested), oauth(credentials));
      return requested;
    }
    return (await this.vault.addUnique(provider, "Profile", oauth(credentials))).name;
  }

  async finalizeLogin(provider: string, name: string, credentials: OAuthCredentials): Promise<void> {
    const credential = oauth(credentials);
    await this.vault.change(state => {
      const scoped = state.providers[provider];
      if (scoped?.profiles[name] && sameCredential(this.pi.getCredential(provider), credential)) scoped.defaultProfile = name;
    });
  }

  async activate(provider: string, name: string, model: string): Promise<void> {
    this.requireProvider(provider);
    if (!this.pi.models(provider).includes(model)) throw new Error("Selected model is not compatible with this provider");
    try {
      await this.vault.transaction(
        state => {
          const scoped = state.providers[provider];
          const profile = scoped?.profiles[name];
          if (!profile) throw new Error("Profile not found");
          const result = { beforeCredential: this.pi.getCredential(provider), beforeModel: this.pi.getModel(), credential: profile.credential };
          scoped.defaultProfile = name;
          scoped.model = model;
          return result;
        },
        async result => {
          this.pi.setCredential(provider, result.credential);
          if (!await this.pi.setModel(model)) throw new Error("model selection failed");
        },
        async result => {
          result.beforeCredential ? this.pi.setCredential(provider, result.beforeCredential) : this.pi.removeCredential(provider);
          if (result.beforeModel) await this.pi.setModel(result.beforeModel);
        },
      );
    } catch {
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
    try {
      const outcome = await this.vault.transaction(
        state => {
          const scoped = state.providers[provider];
          const profile = scoped?.profiles[name];
          if (!profile) throw new Error("Profile not found");
          const beforeCredential = this.pi.getCredential(provider);
          const beforeModel = this.pi.getModel();
          const active = sameCredential(beforeCredential, profile.credential);
          const replacement = Object.keys(scoped.profiles).find(candidate => candidate !== name);
          let result: "deleted" | "switched" | "detached" = "deleted";
          let credential: OAuthCredential | undefined;
          let model: string | undefined;
          if (active && replacement) {
            model = scoped.model && this.pi.models(provider).includes(scoped.model) ? scoped.model : this.pi.models(provider)[0];
            credential = scoped.profiles[replacement]?.credential;
            if (!model || !credential) throw new Error("No compatible replacement is available");
            scoped.defaultProfile = replacement;
            result = "switched";
          } else if (active) result = "detached";
          delete scoped.profiles[name];
          if (!Object.keys(scoped.profiles).length) delete state.providers[provider];
          return { result, credential, model, beforeCredential, beforeModel };
        },
        async value => {
          if (value.result === "switched") {
            if (!value.credential || !value.model) throw new Error("Replacement profile is incomplete");
            this.pi.setCredential(provider, value.credential);
            if (!await this.pi.setModel(value.model)) throw new Error("model selection failed");
          } else if (value.result === "detached") this.pi.removeCredential(provider);
        },
        async value => {
          value.beforeCredential ? this.pi.setCredential(provider, value.beforeCredential) : this.pi.removeCredential(provider);
          if (value.beforeModel) await this.pi.setModel(value.beforeModel);
        },
      );
      return outcome.result;
    } catch {
      throw new Error("Deletion failed; the previous selection was restored");
    }
  }

  async reconcile(provider: string, action: "update" | "create" | "restore", name?: string): Promise<void> {
    if (action === "restore") {
      await this.vault.transaction(
        state => {
          const scoped = state.providers[provider];
          const selected = scoped?.defaultProfile && scoped.profiles[scoped.defaultProfile];
          if (!selected) throw new Error("No Provider Default to restore");
          return { beforeCredential: this.pi.getCredential(provider), credential: selected.credential };
        },
        result => this.pi.setCredential(provider, result.credential),
        result => result.beforeCredential ? this.pi.setCredential(provider, result.beforeCredential) : this.pi.removeCredential(provider),
      );
    } else if (action === "update") {
      await this.vault.change(state => {
        const scoped = state.providers[provider];
        const selected = scoped?.defaultProfile && scoped.profiles[scoped.defaultProfile];
        const mirror = this.pi.getCredential(provider);
        if (!mirror || !selected) throw new Error("A mirror and Provider Default are required");
        selected.credential = structuredClone(mirror);
        selected.generation++;
        selected.status = "ready";
        selected.retryCount = 0;
        delete selected.nextRetryAt;
      });
    } else {
      const requested = this.validateName(name?.trim() ?? "");
      await this.vault.addResolved(provider, requested, () => {
        const mirror = this.pi.getCredential(provider);
        if (!mirror) throw new Error("No OAuth mirror to save");
        return mirror;
      });
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
      await this.vault.transaction(
        state => {
          const current = Object.values(state.providers[provider.id]?.profiles ?? {}).find(value => value.id === profile.id);
          if (!current || current.generation !== profile.generation) return { committed: false } as const;
          const beforeCredential = this.pi.getCredential(provider.id);
          const active = sameCredential(beforeCredential, current.credential);
          current.credential = refreshed;
          current.generation++;
          current.status = "ready";
          current.retryCount = 0;
          delete current.nextRetryAt;
          return { committed: true, active, beforeCredential } as const;
        },
        result => {
          if (result.committed && result.active && sameCredential(this.pi.getCredential(provider.id), result.beforeCredential)) {
            this.pi.setCredential(provider.id, refreshed);
          }
        },
        result => {
          if (!result.committed || !result.active) return;
          result.beforeCredential ? this.pi.setCredential(provider.id, result.beforeCredential) : this.pi.removeCredential(provider.id);
        },
      );
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

}
