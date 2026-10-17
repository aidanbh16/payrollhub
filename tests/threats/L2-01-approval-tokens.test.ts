import { randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, type JWTPayload } from "jose";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as engineStartPOST } from "@/app/api/internal/engine/tenants/[tenantId]/runs/[runId]/start/route";
import { POST as approvePOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/approve/route";
import { POST as editRunPOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/route";
import { POST as idpLoginPOST } from "@/app/mock-idp/[tenantId]/login/route";
import { POST as ssoCallbackPOST } from "@/app/api/auth/sso/[tenantId]/callback/route";
import { SESSION_COOKIE } from "@/application/auth/cookie-names";
import { verifySession } from "@/application/auth/dal";
import { withTenant } from "@/data/db/tenant-scope";
import { rotateSigningKey, signJwtVersioned } from "@/data/keys/kms";
import { SEED_TENANTS, seededPassword, seededTotpSecret, seededIdpPassword } from "@/scripts/lib/seed";
import { issueApprovalToken, verifyApprovalToken } from "@/services/approval/approval-service";
import { mintAsBff } from "@/application/mint-as-bff";
import { startRun } from "@/services/engine/engine-service";
import { getPayrollRun, insertPayrollRun } from "@/services/engine/repository";
import { ApprovalRejectedError, ConflictError, StepUpRequiredError } from "@/services/errors";
import { stepUp } from "@/services/identity/step-up";
import { idsFor, rawSqlite, setupSeededDatabase, nextPayDate } from "../helpers/database";
import { Browser, advance, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// L2-01 (High): a captured approval token replayed to launch an unauthorized payroll run.
// L2-18 (High): approval tokens do not expire or rotate.
// Primary controls: Payroll Approval (services/approval/approval-service.ts) issues a signed token only after a fresh
// MFA step-up, bound to one tenant, run, and approver, with a unique jti, key version, and 5-minute expiry; redemption
// is one atomic UPDATE of redeemed_at. The key store rotates the approval key on demand (npm run keys:rotate).

setupSeededDatabase();

const [acme, globex] = SEED_TENANTS;
let approver: Browser;
let globexApprover: Browser;

function newDraftRun(tenantId = "acme"): string {
  const runId = randomUUID();
  const { hrAdminId } = idsFor(tenantId);
  withTenant(tenantId, (s) => insertPayrollRun(s, { runId, payDate: nextPayDate(), status: "draft", createdBy: hrAdminId, approvedBy: null }));
  return runId;
}

const runStatus = (tenantId: string, runId: string) => withTenant(tenantId, (s) => getPayrollRun(s, runId)?.status);
const tokenRows = (runId: string) =>
  rawSqlite().prepare("SELECT token_id, key_version, redeemed_at FROM approval_token WHERE run_id = ?").all(runId) as {
    token_id: string;
    key_version: number;
    redeemed_at: number | null;
  }[];

/** Approves a run through the real route with a fresh TOTP code. */
async function approve(browser: Browser, runId: string, opts: { tenantId?: string; secret?: string; code?: string } = {}) {
  const tenantId = opts.tenantId ?? "acme";
  advance(31); // a new TOTP time step, so the code is not a replay of the previous one
  const code = opts.code ?? totpNow(opts.secret ?? seededTotpSecret(acme.approver.email));
  return browser.json(approvePOST, `/api/tenants/${tenantId}/runs/${runId}/approve`, { code }, { tenantId, runId });
}

async function approvedToken(runId: string): Promise<string> {
  const res = await approve(approver, runId);
  expect(res.status).toBe(200);
  return (await res.json()).approvalToken;
}

/** Redemption happens only by starting the run: Payroll Engine has Payroll Approval redeem the token (Layer 6). */
async function redeem(runId: string, approvalToken: string, tenantId = "acme") {
  return startRun(await mintAsBff("engine.startRun", tenantId), { tenantId, runId, approvalToken });
}

const rejected = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ApprovalRejectedError);

/** A token's claims without iat and exp, ready to be signed again with a different lifetime. */
function withoutTimes(claims: JWTPayload): JWTPayload {
  const copy = { ...claims };
  delete copy.iat;
  delete copy.exp;
  return copy;
}

beforeAll(async () => {
  useFakeClock();
  approver = new Browser();
  await staffLogin(approver, "acme", acme.approver.email, seededPassword(acme.approver.email), seededTotpSecret(acme.approver.email));
  advance(31);
  globexApprover = new Browser();
  await staffLogin(globexApprover, "globex", globex.approver.email, seededPassword(globex.approver.email), seededTotpSecret(globex.approver.email));
});
afterAll(() => vi.useRealTimers());

describe("[L2-01 DiD] issuing a token requires a fresh MFA step-up", () => {
  it("issues a signed token bound to tenant, run, and approver, recorded in ApprovalToken (control case)", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({ iss: "payrollhub:approval", aud: "payrollhub:engine", tid: "acme", run: runId });
    expect(claims.sub).toBe(verifySession({ get: (n) => (approver.jar.has(n) ? { value: approver.jar.get(n)! } : undefined) })!.userId);
    expect(claims.exp! - claims.iat!).toBe(300);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", kid: "approval-token:v1" });
    expect(tokenRows(runId)).toEqual([{ token_id: claims.jti, key_version: 1, redeemed_at: null }]);
    expect(runStatus("acme", runId)).toBe("approved");
  });

  it("refuses without a correct, unused TOTP code, and issues nothing", async () => {
    const runId = newDraftRun();
    for (const code of ["000000", "", "12345a"]) {
      const res = await approve(approver, runId, { code });
      expect([res.status, await res.json()]).toEqual([403, { error: "Step-up verification failed" }]);
    }
    // A code already used in its time step is refused too: use it once for another run, then try it here.
    advance(31);
    const code = totpNow(seededTotpSecret(acme.approver.email));
    const other = newDraftRun();
    expect((await approver.json(approvePOST, `/api/tenants/acme/runs/${other}/approve`, { code }, { tenantId: "acme", runId: other })).status).toBe(200);
    const replay = await approver.json(approvePOST, `/api/tenants/acme/runs/${runId}/approve`, { code }, { tenantId: "acme", runId });
    expect(replay.status).toBe(403);
    expect(tokenRows(runId)).toEqual([]);
    expect(runStatus("acme", runId)).toBe("draft");
  });

  it("the service refuses to issue without a step-up proof, with a hand-built one, or with a reused one", async () => {
    const runId = newDraftRun();
    const approverId = verifySession({ get: (n) => (approver.jar.has(n) ? { value: approver.jar.get(n)! } : undefined) })!.userId;
    const input = { tenantId: "acme", runId, approverId };
    await expect(issueApprovalToken(await mintAsBff("approval.issueToken", "acme"), input, undefined)).rejects.toBeInstanceOf(StepUpRequiredError);
    const forged = Object.freeze({ userId: approverId, tenantId: "acme", at: new Date() });
    await expect(issueApprovalToken(await mintAsBff("approval.issueToken", "acme"), input, forged)).rejects.toBeInstanceOf(StepUpRequiredError);

    advance(31);
    const claims = verifySession({ get: (n) => (approver.jar.has(n) ? { value: approver.jar.get(n)! } : undefined) })!;
    const stepped = stepUp(claims, { code: totpNow(seededTotpSecret(acme.approver.email)), deviceId: approver.device })!;
    approver.jar.set(SESSION_COOKIE, stepped.cookie);
    await issueApprovalToken(await mintAsBff("approval.issueToken", "acme"), input, stepped.proof);
    await expect(issueApprovalToken(await mintAsBff("approval.issueToken", "acme"), { ...input, runId: newDraftRun() }, stepped.proof)).rejects.toBeInstanceOf(
      StepUpRequiredError,
    );
  });

  it("only a Payroll Approver can approve: an HR Admin and an employee get 403 and no token", async () => {
    const runId = newDraftRun();
    advance(31);
    const admin = new Browser();
    await staffLogin(admin, "acme", acme.hrAdmin.email, seededPassword(acme.hrAdmin.email), seededTotpSecret(acme.hrAdmin.email));
    expect((await approve(admin, runId, { secret: seededTotpSecret(acme.hrAdmin.email) })).status).toBe(403);

    const employee = new Browser();
    const idp = await employee.post(idpLoginPOST, "/mock-idp/acme/login", { email: "alice@acme.test", password: seededIdpPassword(acme.employees[0].email) }, { tenantId: "acme" });
    const assertion = (await idp.text()).match(/name="assertion" value="([^"]+)"/)![1];
    await employee.post(ssoCallbackPOST, "/api/auth/sso/acme/callback", { assertion }, { tenantId: "acme" });
    expect((await approve(employee, runId)).status).toBe(403);

    expect(tokenRows(runId)).toEqual([]);
    expect(runStatus("acme", runId)).toBe("draft");
  });
});

describe("[L2-01] a token works exactly once", () => {
  it("a replayed token is refused", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    expect(await redeem(runId, token)).toMatchObject({ runId });
    const resultsAfterFirst = rawSqlite().prepare("SELECT count(*) AS n FROM pay_result WHERE run_id = ?").get(runId);
    // Refused: the run already moved to computed (checked first), and the token record is already redeemed.
    const replay = await redeem(runId, token).then(() => null, (e: unknown) => e);
    expect(replay instanceof ApprovalRejectedError || replay instanceof ConflictError).toBe(true);
    expect(tokenRows(runId)[0].redeemed_at).not.toBeNull();
    expect(rawSqlite().prepare("SELECT count(*) AS n FROM pay_result WHERE run_id = ?").get(runId)).toEqual(resultsAfterFirst);
  });

  it("two concurrent redemptions: exactly one succeeds", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    const results = await Promise.allSettled([redeem(runId, token), redeem(runId, token), redeem(runId, token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // The losers are refused because the token was used or the run already moved on; either way nothing is written twice.
    const reasons = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
    expect(reasons.every((e) => e instanceof ApprovalRejectedError || e instanceof ConflictError)).toBe(true);
    expect((rawSqlite().prepare("SELECT count(*) AS n FROM pay_result WHERE run_id = ?").get(runId) as { n: number }).n).toBe(3);
  });

  it("over HTTP, the internal engine route also accepts a token once", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    const call = async () =>
      engineStartPOST(
        new NextRequest(`http://localhost:3000/api/internal/engine/tenants/acme/runs/${runId}/start`, {
          method: "POST",
          body: JSON.stringify({ approvalToken: token }),
          headers: { "content-type": "application/json", authorization: `Bearer ${await mintAsBff("engine.startRun", "acme")}` },
        }),
        { params: Promise.resolve({ tenantId: "acme", runId }) },
      );
    expect((await call()).status).toBe(200);
    const replay = await call();
    expect([403, 409]).toContain(replay.status); // token already redeemed, and the run is already computed
  });

  it("a token for tenant A's run is refused against tenant B", async () => {
    const runId = newDraftRun("acme");
    const token = await approvedToken(runId);
    await rejected(redeem(runId, token, "globex"));
    const globexRun = newDraftRun("globex");
    await rejected(redeem(globexRun, token, "globex"));
    expect(tokenRows(runId)[0].redeemed_at).toBeNull(); // still unused: the wrong-tenant attempts changed nothing
  });

  it("a token for one run is refused against another run", async () => {
    const run1 = newDraftRun();
    const run2 = newDraftRun();
    const token = await approvedToken(run1);
    await rejected(redeem(run2, token));
    expect(runStatus("acme", run2)).toBe("draft");
    expect(await redeem(run1, token)).toMatchObject({ runId: run1 }); // the right run still works
  });
});

describe("[L2-18] tokens expire and rotate", () => {
  it("an expired token is refused", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    advance(5 * 60 + 1);
    await rejected(redeem(runId, token));
  });

  it("after rotation, tokens signed with the old key fail, and new tokens use the new version", async () => {
    const runId = newDraftRun();
    const oldToken = await approvedToken(runId);
    expect(decodeProtectedHeader(oldToken).kid).toBe("approval-token:v1");
    expect(rotateSigningKey("approval-token")).toEqual({ version: 2, retired: [1], stillVerify: false });
    await rejected(redeem(runId, oldToken));

    // The approver can approve again at once: a token signed with a retired key can never be redeemed.
    const newToken = await approvedToken(runId);
    expect(decodeProtectedHeader(newToken).kid).toBe("approval-token:v2");
    expect(tokenRows(runId).map((r) => r.key_version).sort()).toEqual([1, 2]);
    expect(await redeem(runId, newToken)).toMatchObject({ runId });
  });

  it("a token re-signed with the live key and a 24-hour lifetime still dies when its record expires", async () => {
    const runId = newDraftRun();
    const claims = withoutTimes(decodeJwt(await approvedToken(runId)));
    advance(4 * 60);
    // As if the issuer had a bug, or an insider could reach the key: same jti, run, and approver, valid signature.
    const { token } = await signJwtVersioned("approval-token", claims, 24 * 60 * 60);
    advance(2 * 60); // 2 minutes old by its own iat, but 6 minutes past the record's issue
    await rejected(redeem(runId, token));
    expect(tokenRows(runId).every((r) => r.redeemed_at === null)).toBe(true);
  });

  it("signature verification caps a token's age at 5 minutes, whatever its exp claim says", async () => {
    const runId = newDraftRun();
    const claims = withoutTimes(decodeJwt(await approvedToken(runId)));
    const { token } = await signJwtVersioned("approval-token", claims, 24 * 60 * 60);
    await expect(verifyApprovalToken(token)).resolves.toMatchObject({ runId });
    advance(5 * 60 + 1);
    await expect(verifyApprovalToken(token)).rejects.toBeInstanceOf(ApprovalRejectedError);
  });
});

describe("[L2-18 DiD] the token record cannot be extended or erased", () => {
  it("the database refuses to move a token's expiry, change its key version, or delete it", async () => {
    const runId = newDraftRun();
    await approvedToken(runId);
    const later = Date.now() + 24 * 60 * 60 * 1000;
    expect(() => rawSqlite().prepare("UPDATE approval_token SET expires_at = ? WHERE run_id = ?").run(later, runId)).toThrow(/write-once/);
    expect(() => rawSqlite().prepare("UPDATE approval_token SET key_version = key_version + 1 WHERE run_id = ?").run(runId)).toThrow(/write-once/);
    expect(() => rawSqlite().prepare("DELETE FROM approval_token WHERE run_id = ?").run(runId)).toThrow(/cannot be deleted/);
  });
});

describe("[L2-01 DiD] only drafts can be approved, and approved runs cannot be edited", () => {
  it("approving a run that already ran is refused with 409", async () => {
    const runId = newDraftRun();
    await redeem(runId, await approvedToken(runId));
    const res = await approve(approver, runId);
    expect([res.status, (await res.json()).error]).toEqual([409, "Only a draft or failed run can be approved"]);
  });

  it("an approved run cannot be edited, through the API or directly in the database", async () => {
    const runId = newDraftRun();
    await approvedToken(runId);
    advance(31);
    const admin = new Browser();
    await staffLogin(admin, "acme", acme.hrAdmin.email, seededPassword(acme.hrAdmin.email), seededTotpSecret(acme.hrAdmin.email));
    const res = await admin.json(editRunPOST, `/api/tenants/acme/runs/${runId}`, { payDate: "2026-12-04" }, { tenantId: "acme", runId });
    expect([res.status, (await res.json()).error]).toEqual([409, "Only a draft run can be changed"]);
    withTenant("acme", () => {
      expect(() => rawSqlite().prepare("UPDATE payroll_run SET pay_date = '2026-12-04', scheduled_run_date = '2026-12-03' WHERE run_id = ?").run(runId)).toThrow(
        /no longer a draft/,
      );
      expect(() => rawSqlite().prepare("UPDATE payroll_run SET status = 'draft' WHERE run_id = ?").run(runId)).toThrow(/no longer a draft|invalid payroll run status change/);
      expect(() => rawSqlite().prepare("DELETE FROM approval_token WHERE run_id = ?").run(runId)).toThrow(/cannot be deleted/);
    });
    // A draft can still be edited.
    const draft = newDraftRun();
    expect((await admin.json(editRunPOST, `/api/tenants/acme/runs/${draft}`, { payDate: "2026-12-04" }, { tenantId: "acme", runId: draft })).status).toBe(200);
  });
});

describe("[L2-01 DiD] the token never reaches browser storage", () => {
  it("is returned only in the JSON body, never in a cookie, and marked no-store", async () => {
    const runId = newDraftRun();
    const before = approver.session;
    const res = await approve(approver, runId);
    const { approvalToken } = await res.clone().json();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.map((c) => c.split("=")[0])).toEqual([SESSION_COOKIE]); // only the rotated session cookie
    expect(setCookies.some((c) => c.includes(approvalToken))).toBe(false);
    expect(approver.session).not.toBe(before); // step-up rotated the session
  });

  it("globex's approver approving a globex run works independently (control)", async () => {
    const runId = newDraftRun("globex");
    const res = await approve(globexApprover, runId, { tenantId: "globex", secret: seededTotpSecret(globex.approver.email) });
    expect(res.status).toBe(200);
  });
});
