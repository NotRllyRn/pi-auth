# pi-auth

pi-auth preserves and selects named OAuth credentials without treating Pi's
single-provider `auth.json` entry as the durable record.

## Language

**Credential Profile**:
A user-named, provider-scoped OAuth credential record stored in the extension
vault.
_Avoid_: token, account, auth file

**Profile Vault**:
The global, permission-restricted extension store that owns credential profiles
and their per-provider defaults.
_Avoid_: auth.json, cache

**Canonical Mirror**:
Pi's provider-keyed `auth.json` credential that reflects the profile currently
selected for that provider.
_Avoid_: source of truth, profile store

**Provider Default**:
The credential profile selected for one provider and used to populate that
provider's canonical mirror.
_Avoid_: global default, active account

**Activation**:
The atomic user action that selects a provider, credential profile, and
compatible model, then updates the canonical mirror.
_Avoid_: login, refresh

**Detachment**:
The state after `/logout` clears a canonical mirror while preserving its saved
credential profiles in the vault.
_Avoid_: delete, revoke

**Reconciliation**:
The explicit `/auth-profile sync` flow that resolves a manually changed
canonical mirror against the profile vault.
_Avoid_: automatic import, file watching

**Needs Login**:
A saved profile whose OAuth refresh failed permanently and must be authenticated
again; it is retained rather than deleted.
_Avoid_: expired profile, invalid token
