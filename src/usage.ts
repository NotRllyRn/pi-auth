import type { OAuthCredential, VaultState } from "./types.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type UsageWindow = { label: string; used: number; resetsAt: number };

export async function profileUsageRows(
	state: VaultState,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
): Promise<string[]> {
	return Promise.all(
		Object.entries(state.providers).flatMap(([provider, scoped]) =>
			Object.entries(scoped.profiles).map(async ([name, profile]) => {
				const prefix = `${provider}/${name}`;
				if (provider !== "openai-codex" || profile.status !== "ready")
					return `${prefix} · usage unavailable`;
				try {
					const windows = await fetchCodexUsage(
						profile.credential,
						fetcher,
						now,
					);
					return `${prefix} · ${windows.map((window) => formatWindow(window, now)).join(" · ")}`;
				} catch {
					return `${prefix} · usage unavailable`;
				}
			}),
		),
	);
}

async function fetchCodexUsage(
	credential: OAuthCredential,
	fetcher: typeof fetch,
	now: number,
): Promise<UsageWindow[]> {
	const accountId = credential.accountId;
	const response = await fetcher(CODEX_USAGE_URL, {
		signal: AbortSignal.timeout(5_000),
		headers: {
			accept: "application/json",
			authorization: `Bearer ${credential.access}`,
			referer: "https://chatgpt.com/codex/settings/usage",
			"x-openai-target-path": "/backend-api/wham/usage",
			...(typeof accountId === "string"
				? { "chatgpt-account-id": accountId }
				: {}),
		},
	});
	if (!response.ok) throw new Error("usage unavailable");
	const root = asRecord(await response.json());
	const rateLimit = asRecord(root.rate_limit ?? root);
	const windows = [
		parseWindow("5h", asRecord(rateLimit.primary_window), now),
		parseWindow("week", asRecord(rateLimit.secondary_window), now),
	];
	const spark = Object.values(asRecord(root.additional_rate_limits)).find(
		(value) =>
			String(asRecord(value).limit_name).toLowerCase().includes("spark"),
	);
	if (spark) {
		const sparkRateLimit = asRecord(asRecord(spark).rate_limit);
		windows.push(
			parseWindow("spark 5h", asRecord(sparkRateLimit.primary_window), now),
			parseWindow("spark week", asRecord(sparkRateLimit.secondary_window), now),
		);
	}
	const available = windows.filter(
		(window): window is UsageWindow => window !== undefined,
	);
	if (available.length === 0) throw new Error("usage unavailable");
	return available;
}

function parseWindow(
	label: string,
	value: Record<string, unknown>,
	now: number,
): UsageWindow | undefined {
	const used = Number(value.used_percent);
	const resetsAt = resetTime(value, now);
	return Number.isFinite(used) && resetsAt !== undefined
		? { label, used, resetsAt }
		: undefined;
}

function resetTime(
	value: Record<string, unknown>,
	now: number,
): number | undefined {
	const resetAt = value.reset_at;
	if (typeof resetAt === "string") {
		const parsed = Date.parse(resetAt);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	if (typeof resetAt === "number")
		return resetAt < 10_000_000_000 ? resetAt * 1_000 : resetAt;
	const seconds = Number(value.reset_after_seconds);
	return Number.isFinite(seconds) ? now + seconds * 1_000 : undefined;
}

function formatWindow(window: UsageWindow, now: number): string {
	const remaining = Math.max(0, Math.min(100, Math.round(100 - window.used)));
	return `${window.label} ${remaining}% left · resets ${formatReset(window.resetsAt - now)}`;
}

function formatReset(milliseconds: number): string {
	if (milliseconds <= 0) return "now";
	const minutes = Math.floor(milliseconds / 60_000);
	const days = Math.floor(minutes / 1_440);
	const hours = Math.floor((minutes % 1_440) / 60);
	const mins = minutes % 60;
	return `in ${
		[days && `${days}d`, hours && `${hours}h`, !days && mins && `${mins}m`]
			.filter(Boolean)
			.join(" ") || "<1m"
	}`;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}
