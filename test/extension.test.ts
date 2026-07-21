import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	Provider,
} from "@earendil-works/pi-ai";
import piAuth from "../src/index.js";

const callbacks = {
	onAuth() {},
	onDeviceCode() {},
	onPrompt: async () => "Work",
	onSelect: async () => undefined,
} satisfies OAuthLoginCallbacks;

type RegisteredOAuth = {
	name: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
};

test("starts without modelRegistry.authStorage and preserves login capture", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-auth-extension-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const events = new Map<string, (...args: unknown[]) => unknown>();
	const registrations = new Map<string, { oauth?: RegisteredOAuth }>();
	let authProfileCommand:
		| ((args: string, ctx: unknown) => Promise<void>)
		| undefined;
	const model = { provider: "anthropic", id: "test" };
	const oauth = {
		name: "Anthropic",
		login: async () => ({
			type: "oauth" as const,
			refresh: "r",
			access: "a",
			expires: Date.now() + 60_000,
		}),
		refresh: async (value: OAuthCredentials & { type: "oauth" }) => value,
		toAuth: async (value: OAuthCredentials) => ({ apiKey: value.access }),
	};
	const supported = {
		id: "anthropic",
		name: "Anthropic",
		auth: { oauth },
	} as unknown as Provider;
	const unsupported = { ...supported, id: "custom", name: "Custom" };
	const catalog = [supported, unsupported];
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
		registerProvider: (name: string, config: { oauth?: RegisteredOAuth }) => {
			registrations.set(name, config);
		},
		setModel: async () => true,
	} as unknown as ExtensionAPI;
	piAuth(pi, catalog);
	let action = "Activate";
	let reloads = 0;
	let shownUsage: string[] | undefined;
	const ctx = {
		mode: "tui",
		model,
		modelRegistry: {
			getAll: () => [model],
			find: () => model,
		},
		reload: async () => {
			reloads++;
			await events.get("session_shutdown")?.({}, ctx);
			piAuth(pi, catalog);
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
		assert.ok(anthropic);
		assert.equal(registrations.has("custom"), false);
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
		const mirror = JSON.parse(
			await readFile(join(agentDir, "auth.json"), "utf8"),
		);
		assert.equal(mirror.anthropic.access, "a");
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
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
		delete process.env.PI_CODING_AGENT_DIR;
	}
});
