import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/data/db/tenant-scope";
import { publicSigningKeys, rotateSigningKey, signBytes, verifyBytes } from "@/data/keys/kms";
import type { MockBank } from "@/partners/mock-bank/server";
import { registerAchKeysWithBank } from "@/scripts/lib/bank-setup";
import { generateCa, issueCert } from "@/scripts/lib/pki";
import { SEED_TENANTS, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { sendBatch } from "@/services/ach/bank-client";
import { buildAchFile } from "@/services/ach/nacha";
import { getAchBatchForRun } from "@/services/ach/repository";
import { BankUnavailableError } from "@/services/errors";
import { batchRows, computedRun, disburse, startBank } from "../helpers/ach";
import { setupSeededDatabase } from "../helpers/database";
import { Browser, staffLogin, useFakeClock } from "../helpers/http";

// L1-22 (High): an unsigned ACH batch is altered in transit to redirect funds.
// Primary control: ACH Disbursement signs the exact file bytes with the key store's ach-batch key (Ed25519), and the
// stand-in bank verifies them against its pinned copy of PayrollHub's public key before accepting anything.
// Defense in depth: mTLS. The bank requires PayrollHub's client certificate; PayrollHub pins the bank's certificate.

setupSeededDatabase();

const [acme] = SEED_TENANTS;
const pki = (file: string) => readFileSync(join(process.env.PKI_DIR!, file), "utf8");
let bank: MockBank;
let approver: Browser;
let serial = 0;

/** A well-formed batch file with a fresh batch ID, paying one entry to the given account. */
function batchFile(accountNumber = "730100000101", routingNumber = "011000015") {
  const batchId = `BTEST${String(++serial).padStart(15, "0")}`;
  const file = buildAchFile({
    batchId,
    originatingBank: { routingNumber: "011000028", name: "Bank" },
    company: { id: "PHACME", name: "Acme Corporation" },
    effectiveDate: "2026-11-27",
    createdAt: new Date(),
    entries: [{ routingNumber, accountNumber, amountCents: 243_750, individualId: "E1", individualName: "Alice Anders" }],
  });
  return { batchId, bytes: Buffer.from(file, "utf8") };
}

const ledger = () => bank.accepted().length;

/** A raw HTTPS request to the bank with the given client TLS material (or none). */
function rawPost(tls: { cert?: string; key?: string }, bytes: Buffer, signature: Buffer, version: number): Promise<number | string> {
  const url = new URL(process.env.BANK_URL!);
  return new Promise((resolve) => {
    const req = request(
      {
        method: "POST", hostname: url.hostname, port: url.port, path: "/ach/batches", ca: pki("ca.pem"), agent: false, ...tls,
        headers: { "content-length": bytes.length, "x-ach-signature": signature.toString("base64"), "x-ach-key-version": String(version) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    req.end(bytes);
  });
}

beforeAll(async () => {
  bank = await startBank();
  useFakeClock();
  approver = new Browser();
  await staffLogin(approver, "acme", acme.approver.email, seededPassword(acme.approver.email), seededTotpSecret(acme.approver.email));
});

afterAll(() => bank.close());

describe("[L1-22] the bank accepts only the exact bytes PayrollHub signed", () => {
  it("a correctly signed batch is accepted", async () => {
    const { bytes } = batchFile();
    const { signature, keyVersion } = signBytes("ach-batch", bytes);
    expect(await sendBatch({ bytes, signature, keyVersion })).toMatchObject({ status: "accepted" });
  });

  it("a single altered byte is rejected (an account number redirected in transit)", async () => {
    const before = ledger();
    const { bytes } = batchFile();
    const { signature, keyVersion } = signBytes("ach-batch", bytes);
    const altered = Buffer.from(bytes.toString("utf8").replace("730100000101", "730100000109"), "utf8");
    expect(altered.length).toBe(bytes.length);
    expect(await sendBatch({ bytes: altered, signature, keyVersion })).toEqual({ status: "rejected", reason: "signature does not verify" });
    // One flipped bit anywhere, too.
    const flipped = Buffer.from(bytes);
    flipped[500] ^= 0x01;
    expect(await sendBatch({ bytes: flipped, signature, keyVersion })).toEqual({ status: "rejected", reason: "signature does not verify" });
    expect(ledger()).toBe(before);
  });

  it("a batch signed with a key the bank never pinned is rejected, whatever version it claims", async () => {
    const before = ledger();
    const { bytes } = batchFile("999988887777", "091000019");
    const attacker = generateKeyPairSync("ed25519").privateKey;
    const forged = sign(null, bytes, attacker);
    expect(await sendBatch({ bytes, signature: forged, keyVersion: 1 })).toEqual({ status: "rejected", reason: "signature does not verify" });
    expect(await sendBatch({ bytes, signature: forged, keyVersion: 99 })).toEqual({ status: "rejected", reason: "unknown signing key" });
    // A real signature presented under a version that does not match it.
    const { signature } = signBytes("ach-batch", bytes);
    expect(await sendBatch({ bytes, signature, keyVersion: 2 })).toEqual({ status: "rejected", reason: "unknown signing key" });
    expect(ledger()).toBe(before);
  });

  it("[L2-13 DiD] a duplicate batch ID is refused even when correctly signed", async () => {
    const { bytes } = batchFile();
    const { signature, keyVersion } = signBytes("ach-batch", bytes);
    expect((await sendBatch({ bytes, signature, keyVersion })).status).toBe("accepted");
    const before = ledger();
    expect(await sendBatch({ bytes, signature, keyVersion })).toMatchObject({ status: "duplicate", sameFile: true });
    expect(ledger()).toBe(before);
  });
});

describe("[L1-22 DiD] mTLS, with the bank's certificate pinned", () => {
  it("PayrollHub refuses a bank certificate that is not the pinned one, even from the same CA, and sends nothing", async () => {
    const { bytes } = batchFile();
    const { signature, keyVersion } = signBytes("ach-batch", bytes);
    await bank.close();
    const before = ledger();
    try {
      // Same CA: the chain and hostname are valid, so only the pin stops it. Another CA: the chain check stops it.
      for (const [ca, reason] of [
        [{ cert: pki("ca.pem"), key: pki("ca-key.pem") }, /^bank certificate not pinned$/],
        [await generateCa("Some Other CA"), /^tls failed/],
      ] as const) {
        const impostor = await startBank({ serverCert: await issueCert(ca, "localhost") });
        try {
          const err = await sendBatch({ bytes, signature, keyVersion }).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(BankUnavailableError);
          expect((err as BankUnavailableError).reason).toMatch(reason);
        } finally {
          await impostor.close();
        }
      }
      expect(ledger()).toBe(before);
    } finally {
      bank = await startBank();
    }
    expect((await sendBatch({ bytes, signature, keyVersion })).status).toBe("accepted");
  });

  it("the bank refuses a connection without PayrollHub's client certificate", async () => {
    const before = ledger();
    const { bytes } = batchFile();
    const { signature, keyVersion } = signBytes("ach-batch", bytes);
    // No client certificate.
    expect(await rawPost({}, bytes, signature, keyVersion)).not.toBe(201);
    // A client certificate from another CA.
    const otherCa = await generateCa("Some Other CA");
    expect(await rawPost(await issueCert(otherCa, "payrollhub-ach"), bytes, signature, keyVersion)).not.toBe(201);
    // The right CA, but not PayrollHub's identity.
    expect(await rawPost(await issueCert({ cert: pki("ca.pem"), key: pki("ca-key.pem") }, "someone-else"), bytes, signature, keyVersion)).toBe(403);
    expect(ledger()).toBe(before);
    // PayrollHub's own certificate works.
    expect(await rawPost({ cert: pki("payrollhub-client.pem"), key: pki("payrollhub-client-key.pem") }, bytes, signature, keyVersion)).toBe(201);
  });
});

describe("[L1-22 DiD] rotating the ACH key keeps old batches verifiable", () => {
  it("old batches still verify (at PayrollHub and at the bank); new batches use the new key; the old key cannot sign", async () => {
    const first = await computedRun(approver);
    const sent1 = await disburse(first);
    expect(sent1.signingKeyVersion).toBe(1);
    const stored1 = withTenant("acme", (s) => getAchBatchForRun(s, first))!;
    const bytes1 = Buffer.from(stored1.fileBody, "utf8");

    const rotated = rotateSigningKey("ach-batch");
    expect(rotated).toEqual({ version: 2, retired: [1], stillVerify: true });
    registerAchKeysWithBank();
    const keyDir = join(process.env.KEYSTORE_DIR!, "ach-batch");
    expect(existsSync(join(keyDir, "v1.pem"))).toBe(false); // the old private key is gone
    expect(existsSync(join(keyDir, "verify-only", "v1.pub.pem"))).toBe(true);
    expect(publicSigningKeys("ach-batch").map((k) => [k.version, k.canSign])).toEqual([[2, true], [1, false]]);

    // The old batch still verifies with v1, here and at the bank (the bank checks the signature before the duplicate).
    expect(verifyBytes("ach-batch", bytes1, stored1.signature!, 1)).toBe(true);
    expect(verifyBytes("ach-batch", bytes1, stored1.signature!, 2)).toBe(false);
    expect(await sendBatch({ bytes: bytes1, signature: stored1.signature!, keyVersion: 1 })).toMatchObject({ status: "duplicate", sameFile: true });

    // New batches are signed with v2 and accepted.
    expect(signBytes("ach-batch", Buffer.from("x")).keyVersion).toBe(2);
    const second = await computedRun(approver);
    const sent2 = await disburse(second);
    expect(sent2).toMatchObject({ status: "sent", signingKeyVersion: 2 });
    expect(batchRows(second)[0].signing_key_version).toBe(2);
    // The first batch's record is unchanged.
    expect(batchRows(first)[0]).toMatchObject({ status: "sent", signing_key_version: 1 });
  });
});
