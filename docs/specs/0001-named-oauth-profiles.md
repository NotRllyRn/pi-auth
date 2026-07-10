# Named OAuth credential profiles

## Problem Statement

Pi stores one OAuth credential per provider in its canonical `auth.json`. Running
built-in `/login` for a provider replaces the currently working credential, so a
user cannot keep and quickly return to multiple accounts for the same provider.
The user needs named, provider-scoped Credential Profiles that preserve those
OAuth credentials, show the selected profile in the TUI, and make activation,
reconciliation, refresh, renaming, detachment, and deletion safe and clear.

## Solution

Deliver an extension-only OAuth profile manager. A global Profile Vault is the
durable source of truth; Pi's provider-keyed `auth.json` remains the Canonical
Mirror for the selected profile of each provider.

The extension will wrap a tested allowlist of Pi OAuth providers through their
public login contract. This lets built-in `/login` run normally while the
extension captures a validated credential before Pi persists the Canonical
Mirror. A successful login creates a new Credential Profile by default and
makes it that provider's Provider Default. A popup profile manager will support
Activation by selecting a provider, Credential Profile, and compatible model
as one user action. It will also support rename, delete, detachment awareness,
manual Reconciliation, and profile-refresh status.

<!-- markdownlint-disable MD013 -->

## User Stories

1. As a Pi user, I want existing supported OAuth credentials imported as a `Default` Credential Profile, so that installing the extension never loses my working login.
2. As a Pi user, I want profiles scoped to a provider, so that I can use different OAuth identities for the same provider without mixing credentials.
3. As a Pi user, I want a Provider Default remembered independently for each provider, so that returning to a provider restores my expected Credential Profile.
4. As a Pi user, I want built-in `/login` to remain the login experience, so that I do not need to learn a replacement authentication workflow.
5. As a Pi user, I want a successful supported OAuth login captured before it replaces the Canonical Mirror, so that a previous Credential Profile remains recoverable.
6. As a Pi user, I want a successful login to create a new Credential Profile by default, so that re-authentication does not silently overwrite a saved identity.
7. As a Pi user, I want to name a newly captured Credential Profile, so that I can distinguish accounts by an understandable label.
8. As a Pi user, I want a generated profile name available as the safe default, so that cancelling name entry still preserves a successful login.
9. As a Pi user, I want profile names unique within a provider, so that profile selection is unambiguous without forbidding sensible names such as `Default` for multiple providers.
10. As a Pi user, I want a popup manager that shows providers and their Credential Profiles, so that I can inspect my available identities without editing secret files.
11. As a Pi user, I want Activation to choose a provider, a Credential Profile, and a compatible model together, so that I cannot accidentally retain an unusable model after changing providers.
12. As a Pi user, I want the popup to preselect a provider's remembered model where available, so that Activation is fast while still explicit.
13. As a Pi user, I want the active provider/profile label in the TUI status area, so that I always know which identity Pi will use.
14. As a Pi user, I want to rename a Credential Profile in the manager, so that I can improve a label without re-authenticating.
15. As a Pi user, I want to delete a non-active Credential Profile with confirmation, so that I can remove an identity deliberately.
16. As a Pi user, I want deleting an active Credential Profile to switch to another saved profile for that provider when possible, so that deletion does not unexpectedly leave me signed out.
17. As a Pi user, I want an explicit signed-out result when I delete the last profile for a provider, so that I understand why that provider can no longer make requests.
18. As a Pi user, I want built-in `/logout` to detach the Canonical Mirror without deleting my Credential Profiles, so that I can reactivate an identity later.
19. As a Pi user, I want a visible detached/signed-out status, so that I do not mistake retained profiles for an active login.
20. As a Pi user, I want an explicit `/auth-profile sync` command after manually editing Pi's credential file, so that I decide whether to update a profile, save a new profile, or restore the selected mirror.
21. As a Pi user, I want ordinary external changes ignored unless I invoke Reconciliation, so that unrelated processes and manual experiments do not silently alter my Profile Vault.
22. As a Pi user, I want inactive Credential Profiles refreshed while Pi is running and they approach access-token expiry, so that they remain usable when I later activate them.
23. As a Pi user, I want a manual refresh-all action, so that I can proactively check the health of my saved profiles.
24. As a Pi user, I want a permanently failed refresh to mark a profile `Needs Login` rather than delete it, so that a transient or revocable provider state never destroys my saved record.
25. As a Pi user, I want transient refresh failures retried safely, so that temporary network or provider outages do not require immediate action.
26. As a Pi user, I want Credential Profiles and refresh tokens stored only in my global user scope with restrictive permissions, so that credentials are not accidentally committed or shared through a project.
27. As a Pi user, I want secrets omitted from labels, status text, prompts, diagnostics, and logs, so that profile management does not expose OAuth credentials.
28. As a Pi user, I want a clear unsupported-provider message, so that I know when an OAuth provider is outside the tested v1 allowlist.
29. As a Pi user running multiple Pi sessions, I want a warning that selection updates the shared Canonical Mirror, so that I understand the last completed Activation wins globally.
30. As a Pi user, I want profile storage to remain intact if Pi or the machine stops during a write, so that I do not lose every saved identity through a partial file.
31. As a Pi user, I want profile changes serialized across Pi processes, so that concurrent login, Activation, refresh, rename, and delete operations do not corrupt the Profile Vault.
32. As a Pi user, I want Pi's normal non-interactive modes to avoid blocking profile popups, so that the extension does not break scripted or RPC use.

<!-- markdownlint-enable MD013 -->

## Implementation Decisions

- The extension owns a global Profile Vault under Pi's user configuration area.
  The vault is versioned and records provider-scoped Credential Profiles,
  per-provider Provider Defaults, model preferences, status metadata, and
  credential-generation metadata needed to reject stale refresh writes.
- A Credential Profile stores an OAuth credential exactly as returned by its
  provider, including provider-specific fields. v1 does not store API keys,
  environment credentials, or project-local credentials.
- The Profile Vault is the source of truth. The Canonical Mirror is a selected
  OAuth credential written through Pi's public authentication storage API.
  Changes to the mirror are not imported automatically except during first-run
  bootstrap or the explicit Reconciliation flow.
- On extension startup, import a supported OAuth credential that exists in the
  Canonical Mirror but has no profile into the provider's `Default` profile.
  Do not remove the mirror during import.
- Restrict v1 to a tested allowlist of OAuth providers. Provider wrapping must
  use public provider-registration and OAuth interfaces only; it must not
  monkey-patch private Pi internals or depend on file watching to identify a
  login.
- For a supported provider, wrap its public OAuth login operation. After the
  original operation validates and returns credentials, persist a new generated
  Credential Profile under the vault lock, then offer name entry. If name entry
  is cancelled, retain the generated name. Only after the profile is safely
  recorded may the wrapper return credentials to Pi for Canonical Mirror
  persistence.
- The profile manager is exposed through `/auth-profile` and uses Pi's
  interactive overlay/select/input/confirmation facilities. Its top-level
  operations are Activation, rename, delete, refresh, and Reconciliation.
- Activation is the highest behavioral seam and is a single transaction from
  the user's perspective: choose provider, Credential Profile, and compatible
  model; write the selected credential to the Canonical Mirror; select the
  model; persist the Provider Default and model preference; then update status.
  On failure, restore the previously consistent selection and report the
  failure without exposing secrets.
- A Provider Default exists per provider, not globally. Because Pi's Canonical
  Mirror is global, concurrent sessions use last completed Activation wins.
  The manager must make that limitation visible before a potentially conflicting
  selection.
- `/logout` is Detachment. It clears the Canonical Mirror without deleting the
  Provider Default or any Credential Profile. The status UI distinguishes a
  detached provider from an active profile.
- `/auth-profile sync` performs Reconciliation against the Canonical Mirror and
  requires the user to choose: update the active Credential Profile, create a
  new named profile, or discard the external value and restore the selected
  profile. It never silently imports arbitrary external changes.
- Deleting an active profile requires confirmation. Activate another saved
  profile for that provider when available; otherwise detach the provider. Show
  a concrete outcome message in both cases.
- While Pi remains running, schedule refreshes for profiles near access-token
  expiry and provide a manual refresh-all action. Persist an updated credential
  only if its recorded generation still matches the value refreshed. Retain
  permanent failures as `Needs Login`; retry transient failures with bounded
  backoff.
- Create the vault directory with owner-only permissions and data files with
  owner-read/write permissions. Use an inter-process lock, temporary-file
  write, flush, and atomic replacement. Never serialize credentials into
  sessions, labels, logs, errors, telemetry, or diagnostics.
- Use a compact persistent status entry for provider/profile and a richer
  overlay for management. TUI-only interactions must return safely without
  custom UI in print, JSON, and RPC modes.

## Testing Decisions

- The primary seam is the extension's public behavior: supported OAuth login
  capture, `/auth-profile` operations, Canonical Mirror state, selected model,
  Profile Vault state, and status output. Tests must assert these observable
  results rather than wrapper structure, private Pi methods, or TUI rendering
  internals.
- Build a controllable fake OAuth provider and fake Pi authentication/model
  interfaces at that seam. It must model successful login, cancellation,
  refresh-token rotation, transient failure, permanent failure, provider
  fields, and model-selection failure.
- Test first-run bootstrap, generated-name cancellation, duplicate names,
  per-provider defaults, supported/unsupported provider behavior, status
  updates, Detachment, active and final-profile deletion, and Reconciliation's
  three outcomes.
- Test Activation as a behavioral transaction: a selected profile and compatible
  model produce the matching Canonical Mirror and status; a failed write or
  model selection preserves/restores the prior consistent state.
- Test refresh timing and status behavior with controlled time. Confirm that
  inactive profiles are refreshed only while Pi runs, rotated credentials are
  retained, transient failures are retried within policy, permanent failures
  become `Needs Login`, and no failure deletes a profile.
- Test storage behavior through the vault interface: schema migration,
  malformed data recovery, strict permissions, atomic-write recovery, stale
  refresh rejection, and process-level lock contention across login, refresh,
  Activation, rename, and delete.
- Test non-interactive mode behavior to confirm commands and lifecycle hooks do
  not wait for a popup or expose secrets.
- Pi's existing authentication-storage locking and OAuth refresh tests are the
  behavioral prior art for concurrency and rotated credentials. Pi extension
  examples covering commands, status labels, provider registration, model
  selection, and overlays are the prior art for extension integration.

## Out of Scope

- Upstream changes to Pi's native authentication schema, built-in command
  dispatch, or first-class named-profile APIs.
- API-key, environment-variable, custom-provider, and project-local credential
  profiles.
- Full support for every OAuth provider before each provider has a tested
  compatibility contract.
- OS keychain integration, encryption at rest, credential sharing/export,
  cloud synchronization, and background refreshing while Pi is not running.
- Session-isolated profile selection. The Canonical Mirror is global and the
  last completed Activation wins.
- Automatic import of arbitrary changes to Pi's credential file.
- Revoking credentials at the OAuth provider when a Credential Profile is
  deleted or Detached.

## Further Notes

The provider-login wrapper is the central feasibility risk for this
extension-only design. It must be proven against the initial allowlist before
building broader profile-management behavior. If it cannot survive Pi provider
registration/refresh lifecycle behavior, the extension must fail closed for
that provider rather than watch `auth.json` or monkey-patch private internals.

The chosen single behavioral seam is the public extension lifecycle plus the
`/auth-profile` command. This is the highest available seam in the empty
repository and captures the user-visible contract without binding tests to
internal components.
