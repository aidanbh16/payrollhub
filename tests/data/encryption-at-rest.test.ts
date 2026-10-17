import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withTenant } from "@/data/db/tenant-scope";
import { getAchBatchForRun, insertAchBatch } from "@/services/ach/repository";
import { getAccountChange, insertAccountChange, listVerifiedAccounts } from "@/services/bank-account/repository";
import { insertPayrollRun } from "@/services/engine/repository";
import { getTotpSecret } from "@/services/identity/repository";
import { SEED_TENANTS } from "@/scripts/lib/seed";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";

// Routing numbers, account numbers, TOTP secrets, and the ACH file body are encrypted at rest (D15).

setupSeededDatabase();

const CHANGE = { routingNumber: "091000019", accountNumber: "999988887777" };
const ACH_ACCOUNT = "123456789012345";
const runId = randomUUID();
let changeId = "";

function databaseBytes(): Buffer {
  rawSqlite().pragma("wal_checkpoint(TRUNCATE)");
  const path = process.env.DATABASE_PATH!;
  return Buffer.concat([readFileSync(path), existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : Buffer.alloc(0)]);
}

describe("encryption at rest", () => {
  it("writes a pending change and an ACH batch that contain full bank numbers", () => {
    const acme = idsFor("acme");
    withTenant("acme", (s) => {
      insertPayrollRun(s, { runId, payDate: "2026-11-27", status: "computed", createdBy: acme.hrAdminId, approvedBy: null });
      insertAchBatch(
        s,
        { batchId: randomUUID(), runId, idempotencyKey: randomUUID(), signature: Buffer.alloc(64), signingKeyVersion: 1, status: "signed", createdAt: new Date(), sentAt: null, entryCount: 0, totalCreditCents: 0 },
        `622${SEED_TENANTS[0].employees[0].routingNumber}${ACH_ACCOUNT}`,
      );
      changeId = insertAccountChange(
        s,
        { employeeId: acme.employeeIds[0], requestedBy: acme.hrAdminId, status: "pending", requestedAt: new Date(), resolvedAt: null },
        CHANGE,
      );
    });
  });

  it("no routing number, account number, TOTP secret, or ACH body appears in plaintext in the database file", () => {
    const bytes = databaseBytes();
    const secrets = [
      ...SEED_TENANTS.flatMap((t) => t.employees.flatMap((e) => [e.routingNumber, e.accountNumber])),
      ...SEED_TENANTS.flatMap((t) => [t.hrAdmin.totpSecret, t.approver.totpSecret]),
      CHANGE.routingNumber,
      CHANGE.accountNumber,
      ACH_ACCOUNT,
    ];
    for (const secret of secrets) expect(bytes.includes(Buffer.from(secret)), secret).toBe(false);

    // Control: unencrypted columns are present, so the scan is reading real row data.
    expect(bytes.includes(Buffer.from("admin@acme.test"))).toBe(true);
    expect(bytes.includes(Buffer.from("Alice Anders"))).toBe(true);
  });

  it("the owning tenant's repository decrypts the values", () => {
    const { hrAdminId } = idsFor("acme");
    withTenant("acme", (s) => {
      const accounts = listVerifiedAccounts(s);
      expect(accounts.map((a) => a.accountNumber).sort()).toEqual(SEED_TENANTS[0].employees.map((e) => e.accountNumber).sort());
      expect(getAccountChange(s, changeId)).toMatchObject(CHANGE);
      expect(getAchBatchForRun(s, runId)?.fileBody).toContain(ACH_ACCOUNT);
      expect(getTotpSecret(s, hrAdminId)).toBe(SEED_TENANTS[0].hrAdmin.totpSecret);
    });
  });

  it("a ciphertext copied into another row does not decrypt (bound to tenant, column, and row)", () => {
    withTenant("acme", (s) => {
      const [first, second] = listVerifiedAccounts(s);
      const db = rawSqlite();
      const blob = db.prepare("SELECT account_number FROM bank_account WHERE bank_account_id = ?").get(first.bankAccountId) as {
        account_number: Buffer;
      };
      const swap = () => db.prepare("UPDATE bank_account SET account_number = ? WHERE bank_account_id = ?").run(blob.account_number, second.bankAccountId);
      // Layer 7 trigger: account numbers never change through SQL.
      expect(swap).toThrow(/permanent/);
      // Someone editing the database file directly is not stopped by triggers; the encryption binding still is.
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bank_account_numbers_fixed'").get() as { sql: string };
      db.exec("DROP TRIGGER bank_account_numbers_fixed");
      try {
        swap();
        expect(() => listVerifiedAccounts(s)).toThrow(/unable to authenticate/i);
      } finally {
        db.exec(trigger.sql);
      }
    });
  });
});
