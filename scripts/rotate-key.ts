import { SIGNING_KEYS, rotateSigningKey, type SigningKeyName } from "@/data/keys/kms";
import { registerAchKeysWithBank } from "./lib/bank-setup";

// Rotates one signing key on demand (L2-18): npm run keys:rotate -- approval-token | service-token | ach-batch
// For JWT keys, every token signed with an older version fails from this moment; a running server picks up the change
// at once. For ach-batch, older versions stop signing but keep verifying, and the new key is registered with the bank.
const name = (process.argv[2] ?? "approval-token") as SigningKeyName;
if (!SIGNING_KEYS.includes(name)) {
  console.error(`Unknown key "${name}". Choose one of: ${SIGNING_KEYS.join(", ")}`);
  process.exit(1);
}
const { version, retired, stillVerify } = rotateSigningKey(name);
if (stillVerify) {
  // Register the new public key with the stand-in bank, so batches signed with it are accepted. The bank keeps
  // trusting old versions, so batches already sent stay verifiable there too.
  registerAchKeysWithBank();
  console.log(`Rotated ${name}: now signing with v${version}; v${retired.join(", v")} can no longer sign but still verify existing batches. Registered v${version} with the stand-in bank.`);
} else {
  console.log(`Rotated ${name}: now signing with v${version}; retired v${retired.join(", v")}. Tokens signed with retired versions no longer verify.`);
}
