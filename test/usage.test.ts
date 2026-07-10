import assert from "node:assert/strict";
import test from "node:test";
import type { VaultState } from "../src/types.js";
import { profileUsageRows } from "../src/usage.js";

const credential = {
	type: "oauth" as const,
	access: "secret-access",
	refresh: "secret-refresh",
	expires: Number.MAX_SAFE_INTEGER,
	accountId: "account-1",
};

const state: VaultState = {
	version: 1,
	providers: {
		"openai-codex": {
			profiles: {
				Work: {
					id: "work",
					credential,
					generation: 1,
					status: "ready",
					retryCount: 0,
				},
			},
		},
		anthropic: {
			profiles: {
				Personal: {
					id: "personal",
					credential,
					generation: 1,
					status: "ready",
					retryCount: 0,
				},
			},
		},
	},
};

test("shows remaining Codex quota and reset time for every profile", async () => {
	let headers = new Headers();
	const fetcher: typeof fetch = async (_input, init) => {
		headers = new Headers(init?.headers);
		return new Response(
			JSON.stringify({
				rate_limit: {
					primary_window: { used_percent: 50, reset_after_seconds: 3_600 },
					secondary_window: {
						used_percent: 25,
						reset_after_seconds: 90_000,
					},
				},
				additional_rate_limits: {
					spark: {
						limit_name: "GPT-5 Spark",
						rate_limit: {
							primary_window: {
								used_percent: 10,
								reset_after_seconds: 1_800,
							},
						},
					},
				},
			}),
		);
	};

	assert.deepEqual(await profileUsageRows(state, fetcher, 1_000), [
		"openai-codex/Work · 5h 50% left · resets in 1h · week 75% left · resets in 1d 1h · spark 5h 90% left · resets in 30m",
		"anthropic/Personal · usage unavailable",
	]);
	assert.equal(headers.get("authorization"), "Bearer secret-access");
	assert.equal(headers.get("chatgpt-account-id"), "account-1");
});

test("keeps failed profiles visible without exposing request errors", async () => {
	const fetcher: typeof fetch = async () => {
		throw new Error("secret-access was rejected");
	};
	assert.deepEqual(await profileUsageRows(state, fetcher), [
		"openai-codex/Work · usage unavailable",
		"anthropic/Personal · usage unavailable",
	]);
});
