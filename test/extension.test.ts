import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	OAuthLoginCallbacks,
	OAuthProviderInterface,
} from "@earendil-works/pi-ai/compat";
import piAuth from "../src/index.js";

const callbacks = {
	onAuth() {},
	onDeviceCode() {},
	onPrompt: async () => "Work",
	onSelect: async () => undefined,
} satisfies OAuthLoginCallbacks;

test("wraps supported login capture and rejects unsupported login clearly", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-auth-extension-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const events = new Map<string, (...args: unknown[]) => unknown>();
	const registrations = new Map<
		string,
		{ oauth?: Omit<OAuthProviderInterface, "id"> }
	>();
	let authProfileCommand:
		| ((args: string, ctx: unknown) => Promise<void>)
		| undefined;
	const supported: OAuthProviderInterface = {
		id: "anthropic",
		name: "Anthropic",
		login: async () => ({
			refresh: "r",
			access: "a",
			expires: Date.now() + 60_000,
		}),
		refreshToken: async (value) => value,
		getApiKey: (value) => value.access,
	};
	const unsupported = { ...supported, id: "custom", name: "Custom" };
	let oauthProviders = [supported, unsupported];
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			events.set(name, handler);
		},
		registerCommand(
			name: string,
			config: { handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			if (name === "auth-profile") authProfileCommand = config.handler;
		},
		registerProvider: (
			name: string,
			config: { oauth?: Omit<OAuthProviderInterface, "id"> },
		) => {
			registrations.set(name, config);
			if (config.oauth) {
				const registered = {
					...config.oauth,
					id: name,
				} as OAuthProviderInterface;
				oauthProviders = [
					...oauthProviders.filter((value) => value.id !== name),
					registered,
				];
			}
		},
		setModel: async () => true,
	} as unknown as ExtensionAPI;
	piAuth(pi);
	const auth = new Map();
	const model = { provider: "anthropic", id: "test" };
	let action = "Activate";
	let reloads = 0;
	let shownUsage: string[] | undefined;
	const ctx = {
		mode: "tui",
		model,
		modelRegistry: {
			authStorage: {
				getOAuthProviders: () => oauthProviders,
				get: (id: string) => auth.get(id),
				set: (id: string, value: unknown) => auth.set(id, value),
				remove: (id: string) => auth.delete(id),
			},
			getAll: () => [model],
			find: () => model,
		},
		reload: async () => {
			reloads++;
			await events.get("session_shutdown")?.({}, ctx);
			piAuth(pi);
			await events.get("session_start")?.({}, ctx);
		},
		ui: {
			setStatus() {},
			notify() {},
			confirm: async () => true,
			select: async (title: string, options: string[]) => {
				if (title === "Credential Profiles") return action;
				if (title === "Credential Profile Usage") shownUsage = options;
				return options[0];
			},
		},
	};
	await events.get("session_start")?.({}, ctx);
	try {
		const anthropic = registrations.get("anthropic")?.oauth;
		const custom = registrations.get("custom")?.oauth;
		assert.ok(anthropic);
		assert.ok(custom);
		await anthropic.login(callbacks);
		const vault = JSON.parse(
			await readFile(join(agentDir, "pi-auth", "profiles.json"), "utf8"),
		);
		assert.equal(
			vault.providers.anthropic.profiles.Work.credential.access,
			"a",
		);
		assert.ok(authProfileCommand);
		await authProfileCommand("", ctx);
		assert.equal(reloads, 1);
		let prompts = 0;
		const reloaded = registrations.get("anthropic")?.oauth;
		assert.ok(reloaded);
		await reloaded.login({
			...callbacks,
			onPrompt: async () => (prompts++, "Reloaded"),
		});
		assert.equal(prompts, 1);
		action = "Usage";
		await authProfileCommand("", ctx);
		assert.ok(shownUsage?.every((row) => row.endsWith("usage unavailable")));
		await assert.rejects(
			custom.login(callbacks),
			/does not support OAuth login for custom/,
		);
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
		delete process.env.PI_CODING_AGENT_DIR;
	}
});
