# pi-auth

`pi-auth` is a Pi extension for saving and switching named OAuth Credential
Profiles. Its locked global Profile Vault is the source of truth; Pi's
`auth.json` remains the active Canonical Mirror.

## Install

```bash
pi install git:github.com/NotRllyRn/pi-auth
```

Restart Pi, then use built-in `/login` or open `/auth-profile`.

## Commands

- `/auth-profile` — activate, rename, delete, refresh, or reconcile profiles.
- `/auth-profile sync` — reconcile a manually changed `auth.json` entry.
- `/login` — logs in normally and saves the result as a new profile.
- `/logout` — signs out without deleting saved profiles.

v1 supports OAuth for Anthropic, GitHub Copilot, and OpenAI Codex. It does not
store API keys. Activations are global: the last completed Activation wins
across running Pi sessions.

See [docs/usage.md](docs/usage.md) for the workflow and
[issue #1](https://github.com/NotRllyRn/pi-auth/issues/1) for the specification.
