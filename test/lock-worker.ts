import { Vault } from "../src/vault.js";

const [, , path, prefix] = process.argv;
if (!path || !prefix) throw new Error("path and prefix are required");
const vault = new Vault(path);
for (let index = 0; index < 5; index++) {
  await vault.add("anthropic", `${prefix}-${index}`, { type: "oauth", refresh: "r", access: `${prefix}-${index}`, expires: 1 });
}
