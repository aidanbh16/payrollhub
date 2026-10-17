import { env } from "@/config/env";
import { publicSigningKeys } from "@/data/keys/kms";
import { trustSigningKey } from "@/partners/mock-bank/server";
import { provisionPki } from "./pki";

// Development setup for the stand-in bank (D12): the local CA and certificates, and the out-of-band registration of
// PayrollHub's ACH signing public keys with the bank (which pins them). Run by setup, db:reset, and keys:rotate.

/** Registers every ACH signing key version that still verifies, so old batches stay verifiable at the bank too. */
export function registerAchKeysWithBank(): void {
  for (const k of publicSigningKeys("ach-batch")) trustSigningKey(env().MOCK_BANK_DIR, k.version, k.publicKeyPem);
}

export async function provisionBank(): Promise<void> {
  await provisionPki(env().PKI_DIR);
  registerAchKeysWithBank();
}
