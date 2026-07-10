# Usage

## Save a profile

Run Pi's built-in `/login`. After OAuth succeeds, pi-auth saves the credential
before Pi updates `auth.json`. Enter a name, or cancel to keep the generated
name.

On first start, an existing supported OAuth credential is imported as
`Default`.

## Activate a profile

Run `/auth-profile`, choose **Activate**, then choose a provider, profile, and
model. Confirm the global Canonical Mirror update.

The footer shows `auth: provider/profile`. `(detached)` means the profiles are
saved but that provider is signed out or `auth.json` changed externally.

## Maintain profiles

`/auth-profile` also provides:

- **Rename** — changes only the profile label.
- **Delete** — confirms removal; activates another profile or signs out.
- **Refresh all** — refreshes saved OAuth credentials.
- **Reconcile** — updates a profile, creates one from `auth.json`, or restores
  the selected profile to `auth.json`.

Use `/auth-profile sync` to open Reconciliation directly.

## Storage and safety

The vault is `~/.pi/agent/pi-auth/profiles.json`. Its directory is mode `0700`
and its file is mode `0600`. Writes use a process lock and atomic replacement.
Credentials never appear in status text or extension error messages.

Profile dialogs run only in Pi's interactive TUI. Print, JSON, and RPC modes do
not wait for them.
