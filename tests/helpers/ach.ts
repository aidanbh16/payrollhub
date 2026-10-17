import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { POST as approvePOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/approve/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { withTenant } from "@/data/db/tenant-scope";
import { startMockBank, type MockBank } from "@/partners/mock-bank/server";
import { SEED_TENANTS, seededTotpSecret } from "@/scripts/lib/seed";
import { disburseRun } from "@/services/ach/ach-service";
import { startRun } from "@/services/engine/engine-service";
import { insertPayrollRun } from "@/services/engine/repository";
import { idsFor, rawSqlite } from "./database";
import { advance, totpNow, type Browser } from "./http";

/** Starts the stand-in bank on this test file's BANK_URL port, with this file's certificates and bank directory. */
export function startBank(options: { serverCert?: { cert: string; key: string } } = {}): Promise<MockBank> {
  return startMockBank({
    pkiDir: process.env.PKI_DIR!,
    bankDir: process.env.MOCK_BANK_DIR!,
    port: Number(new URL(process.env.BANK_URL!).port),
    ...options,
  });
}

/** A run created by the HR Admin, approved by the approver (fresh TOTP), and computed by Payroll Engine. */
export async function computedRun(approver: Browser, tenantId = "acme"): Promise<string> {
  const runId = randomUUID();
  const createdBy = idsFor(tenantId).hrAdminId;
  withTenant(tenantId, (s) => insertPayrollRun(s, { runId, payDate: "2026-11-27", status: "draft", createdBy, approvedBy: null }));
  advance(31);
  const secret = seededTotpSecret(SEED_TENANTS.find((t) => t.tenantId === tenantId)!.approver.email);
  const res = await approver.json(approvePOST, `/api/tenants/${tenantId}/runs/${runId}/approve`, { code: totpNow(secret) }, { tenantId, runId });
  expect(res.status).toBe(200);
  const { approvalToken } = await res.json();
  await startRun(await mintAsBff("engine.startRun", tenantId), { tenantId, runId, approvalToken });
  return runId;
}

/** "Send to bank", called the way the internal ACH route calls it. */
export async function disburse(runId: string, tenantId = "acme") {
  return disburseRun(await mintAsBff("ach.disburse", tenantId), { tenantId, runId });
}

export const batchRows = (runId: string) =>
  rawSqlite().prepare("SELECT batch_id, status, signing_key_version, entry_count, total_credit_cents, bank_reference FROM ach_batch WHERE run_id = ?").all(runId) as {
    batch_id: string;
    status: string;
    signing_key_version: number;
    entry_count: number;
    total_credit_cents: number;
    bank_reference: string | null;
  }[];

export const runStatus = (runId: string) =>
  (rawSqlite().prepare("SELECT status, failure_reason FROM payroll_run WHERE run_id = ?").get(runId) as { status: string; failure_reason: string | null });
