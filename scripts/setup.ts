import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { provisionPki } from "./lib/pki";

// One-time local setup: creates .env from .env.example and fills in generated development secrets.
// Existing values in .env are never overwritten.
const GENERATED: Record<string, () => string> = {
  FIELD_ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
};

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  console.log("Created .env from .env.example");
}

let contents = readFileSync(".env", "utf8");
for (const [name, generate] of Object.entries(GENERATED)) {
  const line = new RegExp(`^${name}=(.*)$`, "m");
  const match = contents.match(line);
  if (match && match[1].trim() !== "") continue;
  contents = match ? contents.replace(line, `${name}=${generate()}`) : `${contents.trimEnd()}\n${name}=${generate()}\n`;
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
