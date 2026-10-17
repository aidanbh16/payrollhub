import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { provisionPki } from "./lib/pki";

// One-time local setup: creates .env from .env.example and fills in generated development secrets, so every install
// has its own: the field-encryption key, the Redis password (RT-05), and (below) the local CA. Existing values in .env
// are never overwritten, except the Redis password that older versions of .env.example published.
const PUBLISHED_REDIS_PASSWORD = "dev-only-redis-password-change-me";
const redisPassword = randomBytes(24).toString("base64url");
const GENERATED: Record<string, (current: string) => string | undefined> = {
  FIELD_ENCRYPTION_KEY: (current) => (current === "" ? randomBytes(32).toString("base64") : undefined),
  REDIS_PASSWORD: (current) => (current === "" || current === PUBLISHED_REDIS_PASSWORD ? redisPassword : undefined),
  // Must match REDIS_PASSWORD, so it is filled after it (object keys keep their order).
  REDIS_URL: (current) =>
    current === "" || current.includes(PUBLISHED_REDIS_PASSWORD)
      ? `redis://:${contents.match(/^REDIS_PASSWORD=(.*)$/m)?.[1].trim() || redisPassword}@127.0.0.1:6379`
      : undefined,
};

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  console.log("Created .env from .env.example");
}

let contents = readFileSync(".env", "utf8");
for (const [name, generate] of Object.entries(GENERATED)) {
  const line = new RegExp(`^${name}=(.*)$`, "m");
  const match = contents.match(line);
  const value = generate(match?.[1].trim() ?? "");
  if (value === undefined) continue;
  contents = match ? contents.replace(line, () => `${name}=${value}`) : `${contents.trimEnd()}\n${name}=${value}\n`;
  console.log(`Generated ${name} in .env`);
}
writeFileSync(".env", contents);
mkdirSync(".data", { recursive: true });

// The local CA, the stand-in bank's server certificate, PayrollHub's client certificate, and the bank pin (D12).
const pkiDir = contents.match(/^PKI_DIR=(.+)$/m)?.[1].trim() || ".data/pki";
provisionPki(pkiDir)
  .then((created) => {
    console.log(created ? `Generated the local CA and mTLS certificates in ${pkiDir}` : `Certificates already exist in ${pkiDir}`);
    console.log("Setup complete. Next: docker compose up -d, then npm run db:reset, then npm run bank and npm run dev.");
  })
  .catch((err: Error) => {
    console.error(`Could not generate certificates: ${err.message}`);
    process.exit(1);
  });
