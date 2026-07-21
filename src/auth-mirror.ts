import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { OAuthCredential } from "./types.js";

type Credential = OAuthCredential | { type: "api_key"; key?: string };
type AuthState = Record<string, Credential>;

/** Locked access to Pi's provider-keyed auth.json mirror. */
export class AuthMirror {
	constructor(private readonly path: string) {}

	get(provider: string): OAuthCredential | undefined {
		return this.withLock((state) => {
			const credential = state[provider];
			return credential?.type === "oauth" ? credential : undefined;
		});
	}

	set(provider: string, credential: OAuthCredential): void {
		this.withLock((state) => {
			state[provider] = credential;
			this.persist(state);
		});
	}

	remove(provider: string): void {
		this.withLock((state) => {
			delete state[provider];
			this.persist(state);
		});
	}

	private withLock<T>(operation: (state: AuthState) => T): T {
		this.ensureFile();
		const release = this.acquire();
		try {
			return operation(
				JSON.parse(readFileSync(this.path, "utf8")) as AuthState,
			);
		} finally {
			release();
		}
	}

	private acquire(): () => void {
		for (let attempt = 0; ; attempt++) {
			try {
				return lockfile.lockSync(this.path, { realpath: false });
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code !== "ELOCKED" ||
					attempt === 9
				)
					throw error;
				const retryAt = Date.now() + 20;
				while (Date.now() < retryAt) {
					/* Match Pi's synchronous auth-store lock retry. */
				}
			}
		}
	}

	private ensureFile(): void {
		const directory = dirname(this.path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		if (!existsSync(this.path))
			writeFileSync(this.path, "{}\n", { mode: 0o600 });
		chmodSync(this.path, 0o600);
	}

	private persist(state: AuthState): void {
		writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`, {
			mode: 0o600,
		});
		chmodSync(this.path, 0o600);
	}
}
