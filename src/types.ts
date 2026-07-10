import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";

export type OAuthCredential = { type: "oauth" } & OAuthCredentials;
type ProfileStatus = "ready" | "retrying" | "needs-login";

export interface CredentialProfile {
  id: string;
  credential: OAuthCredential;
  generation: number;
  status: ProfileStatus;
  retryCount: number;
  nextRetryAt?: number;
}

interface ProviderProfiles {
  profiles: Record<string, CredentialProfile>;
  defaultProfile?: string;
  model?: string;
}

export interface VaultState {
  version: 1;
  providers: Record<string, ProviderProfiles>;
}

export const emptyVault = (): VaultState => ({ version: 1, providers: {} });
