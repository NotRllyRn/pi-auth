import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { OAuthProviderInterface } from "@earendil-works/pi-ai/compat";
import { ProfileManager, type PiAdapter } from "./manager.js";
import { profileUsageRows } from "./usage.js";
import { Vault } from "./vault.js";

const ALLOWLIST = new Set(["anthropic", "github-copilot", "openai-codex"]);
const ORIGINAL_PROVIDER = Symbol.for("pi-auth.original-oauth-provider");
type WrappedProvider = Omit<OAuthProviderInterface, "id"> & {
	[ORIGINAL_PROVIDER]: OAuthProviderInterface;
};
const unwrapProvider = (provider: OAuthProviderInterface) =>
	(provider as OAuthProviderInterface & Partial<WrappedProvider>)[
		ORIGINAL_PROVIDER
	] ?? provider;
const displayError =
	"Profile operation failed; saved credentials were not changed";

export default function piAuth(pi: ExtensionAPI) {
	let manager: ProfileManager | undefined;
	let selectedModel: string | undefined;
	let statusTimer: NodeJS.Timeout | undefined;
	let refreshTimer: NodeJS.Timeout | undefined;

	const updateStatus = async (ctx: ExtensionContext) => {
		const provider = selectedModel?.slice(0, selectedModel.indexOf("/"));
		if (
			!manager ||
			!provider ||
			!manager.supportedProviders().includes(provider)
		)
			return ctx.ui.setStatus("pi-auth", undefined);
		ctx.ui.setStatus("pi-auth", `auth: ${await manager.status(provider)}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		selectedModel = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
		const oauthProviders = ctx.modelRegistry.authStorage
			.getOAuthProviders()
			.map(unwrapProvider);
		const originals = oauthProviders.filter((provider) =>
			ALLOWLIST.has(provider.id),
		);
		const providers = new Map(
			originals.map((provider) => [provider.id, provider]),
		);
		const adapter: PiAdapter = {
			getCredential: (provider) => {
				const value = ctx.modelRegistry.authStorage.get(provider);
				return value?.type === "oauth" ? value : undefined;
			},
			setCredential: (provider, credential) =>
				ctx.modelRegistry.authStorage.set(provider, credential),
			removeCredential: (provider) =>
				ctx.modelRegistry.authStorage.remove(provider),
			getModel: () => selectedModel,
			setModel: async (value) => {
				const separator = value.indexOf("/");
				const model = ctx.modelRegistry.find(
					value.slice(0, separator),
					value.slice(separator + 1),
				);
				if (!model || !(await pi.setModel(model))) return false;
				selectedModel = value;
				return true;
			},
			models: (provider) =>
				ctx.modelRegistry
					.getAll()
					.flatMap((model) =>
						model.provider === provider ? [`${provider}/${model.id}`] : [],
					),
		};
		manager = new ProfileManager(
			new Vault(join(getAgentDir(), "pi-auth", "profiles.json")),
			adapter,
			providers,
		);

		for (const provider of originals)
			pi.registerProvider(provider.id, {
				oauth: wrapProvider(provider, () => {
					if (!manager) throw new Error("Profile manager is not ready");
					return manager;
				}),
			});
		for (const provider of oauthProviders.filter(
			(value) => !ALLOWLIST.has(value.id),
		)) {
			pi.registerProvider(provider.id, {
				oauth: rejectUnsupportedProvider(provider),
			});
		}
		await manager.bootstrap();
		await updateStatus(ctx);
		statusTimer = setInterval(() => void updateStatus(ctx), 2_000);
		refreshTimer = setInterval(() => void manager?.refreshAll(true), 60_000);
		void manager.refreshAll(true);
	});

	pi.on("model_select", async (event, ctx) => {
		selectedModel = `${event.model.provider}/${event.model.id}`;
		await updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		if (statusTimer) clearInterval(statusTimer);
		if (refreshTimer) clearInterval(refreshTimer);
	});

	pi.registerCommand("auth-profile", {
		description: "Manage named OAuth Credential Profiles",
		handler: async (args, ctx) => {
			if (!manager) return;
			if (ctx.mode !== "tui")
				return ctx.ui.notify(
					"Credential Profile dialogs are available only in interactive mode",
					"warning",
				);
			try {
				const action =
					args.trim() === "sync"
						? "Reconcile"
						: await ctx.ui.select("Credential Profiles", [
								"Activate",
								"Usage",
								"Rename",
								"Delete",
								"Refresh all",
								"Reconcile",
							]);
				if (!action) return;
				if (action === "Activate") {
					await activate(manager, ctx);
					return;
				}
				if (action === "Refresh all") {
					await manager.refreshAll();
					ctx.ui.notify("Credential Profiles refreshed", "info");
				} else if (action === "Usage") await showUsage(manager, ctx);
				else if (action === "Rename") await rename(manager, ctx);
				else if (action === "Delete") await remove(manager, ctx);
				else await reconcile(manager, ctx);
				await updateStatus(ctx);
			} catch {
				ctx.ui.notify(displayError, "error");
			}
		},
	});
}

function rejectUnsupportedProvider(
	provider: OAuthProviderInterface,
): WrappedProvider {
	return {
		[ORIGINAL_PROVIDER]: provider,
		name: provider.name,
		...(provider.usesCallbackServer !== undefined && {
			usesCallbackServer: provider.usesCallbackServer,
		}),
		refreshToken: (credential) => provider.refreshToken(credential),
		getApiKey: (credential) => provider.getApiKey(credential),
		...(provider.modifyModels && {
			modifyModels: provider.modifyModels.bind(provider),
		}),
		login: async () => {
			throw new Error(
				`pi-auth does not support OAuth login for ${provider.id}`,
			);
		},
	};
}

function wrapProvider(
	provider: OAuthProviderInterface,
	current: () => ProfileManager,
): WrappedProvider {
	return {
		[ORIGINAL_PROVIDER]: provider,
		name: provider.name,
		...(provider.usesCallbackServer !== undefined && {
			usesCallbackServer: provider.usesCallbackServer,
		}),
		refreshToken: (credential) => provider.refreshToken(credential),
		getApiKey: (credential) => provider.getApiKey(credential),
		...(provider.modifyModels && {
			modifyModels: provider.modifyModels.bind(provider),
		}),
		login: async (callbacks) => {
			const credential = await provider.login(callbacks);
			let name = await current().capture(provider.id, credential);
			try {
				const requested = (
					await callbacks.onPrompt({
						message: `Name saved ${provider.name} profile`,
						placeholder: name,
					})
				).trim();
				if (requested && requested !== name) {
					await current().rename(provider.id, name, requested);
					name = requested;
				}
			} catch {
				/* Cancellation keeps the generated name and successful login. */
			}
			setTimeout(
				() =>
					void current()
						.finalizeLogin(provider.id, name, credential)
						.catch(() => {}),
				0,
			);
			return credential;
		},
	};
}

async function chooseProfile(
	manager: ProfileManager,
	ctx: ExtensionCommandContext,
) {
	const state = await manager.state();
	const provider = await ctx.ui.select(
		"Provider",
		manager.supportedProviders().filter((id) => state.providers[id]),
	);
	if (!provider) return;
	const scoped = state.providers[provider];
	if (!scoped) return;
	const profiles = Object.entries(scoped.profiles);
	const labels = profiles.map(
		([name, profile]) =>
			`${name}${scoped.defaultProfile === name ? " · default" : ""}${profile.status === "ready" ? "" : ` · ${profile.status === "needs-login" ? "Needs Login" : "retrying"}`}`,
	);
	const selected = await ctx.ui.select("Credential Profile", labels);
	const profile = selected && profiles[labels.indexOf(selected)]?.[0];
	return profile ? { provider, profile, state } : undefined;
}

async function showUsage(
	manager: ProfileManager,
	ctx: ExtensionCommandContext,
) {
	await manager.refreshAll(true);
	const rows = await profileUsageRows(await manager.state());
	if (rows.length === 0)
		return ctx.ui.notify("No saved Credential Profiles", "info");
	await ctx.ui.select("Credential Profile Usage", rows);
}

async function activate(manager: ProfileManager, ctx: ExtensionCommandContext) {
	const choice = await chooseProfile(manager, ctx);
	if (!choice) return;
	const models = manager.models(choice.provider);
	const preferred = choice.state.providers[choice.provider]?.model;
	const model = await ctx.ui.select(
		"Compatible model",
		preferred
			? [preferred, ...models.filter((value) => value !== preferred)]
			: models,
	);
	if (
		!model ||
		!(await ctx.ui.confirm(
			"Activate Credential Profile?",
			"This updates the shared Canonical Mirror. The last completed Activation wins.",
		))
	)
		return;
	await manager.activate(choice.provider, choice.profile, model);
	ctx.ui.notify(`Activated ${choice.provider}/${choice.profile}`, "info");
	await ctx.reload();
}

async function rename(manager: ProfileManager, ctx: ExtensionCommandContext) {
	const choice = await chooseProfile(manager, ctx);
	if (!choice) return;
	const name = await ctx.ui.input("New profile name", choice.profile);
	if (!name) return;
	await manager.rename(choice.provider, choice.profile, name);
	ctx.ui.notify(`Renamed to ${name}`, "info");
}

async function remove(manager: ProfileManager, ctx: ExtensionCommandContext) {
	const choice = await chooseProfile(manager, ctx);
	if (
		!choice ||
		!(await ctx.ui.confirm(
			"Delete Credential Profile?",
			`${choice.provider}/${choice.profile} will be removed locally.`,
		))
	)
		return;
	const result = await manager.delete(choice.provider, choice.profile);
	let message = "Credential Profile deleted";
	if (result === "switched")
		message = "Deleted; another saved profile was activated";
	else if (result === "detached")
		message = "Deleted last profile; provider is signed out";
	ctx.ui.notify(message, "info");
}

async function reconcile(
	manager: ProfileManager,
	ctx: ExtensionCommandContext,
) {
	const provider = await ctx.ui.select(
		"Provider to reconcile",
		manager.supportedProviders(),
	);
	if (!provider) return;
	const action = await ctx.ui.select("Canonical Mirror differs", [
		"Update Provider Default",
		"Create Credential Profile",
		"Restore Provider Default",
	]);
	if (!action) return;
	if (action === "Update Provider Default")
		await manager.reconcile(provider, "update");
	else if (action === "Restore Provider Default")
		await manager.reconcile(provider, "restore");
	else {
		const name = await ctx.ui.input("New profile name", "Imported");
		if (name) await manager.reconcile(provider, "create", name);
	}
	ctx.ui.notify("Reconciliation complete", "info");
}
