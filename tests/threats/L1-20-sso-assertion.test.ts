import { createPrivateKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, base64url } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as ssoCallbackPOST } from "@/app/api/auth/sso/[tenantId]/callback/route";
import { POST as idpLoginPOST } from "@/app/mock-idp/[tenantId]/login/route";
import { idpAudience, idpIssuer } from "@/partners/mock-idp/idp";
import { SEED_TENANTS, ssoSubjectFor, seededIdpPassword } from "@/scripts/lib/seed";
import { readSession } from "@/services/identity/sessions";
import { signInWithSso, verifySsoAssertion } from "@/services/identity/sso";
import { rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, location, useFakeClock } from "../helpers/http";

// L1-20 (High): a forged SSO assertion signs in as any employee of a tenant.
// Primary control: services/identity/sso.ts verifies every assertion against the tenant's registered IdP key and
// configuration (signature, pinned ES256, issuer, audience, expiry, tenant) before any session is created.

setupSeededDatabase();

const alice = ssoSubjectFor("acme", "alice@acme.test");
const dana = ssoSubjectFor("globex", "dana@globex.test");
let acmeKey: KeyObject;
let globexKey: KeyObject;

beforeAll(() => {
  const keyOf = (tenant: string) => createPrivateKey(readFileSync(join(process.env.MOCK_IDP_DIR!, `${tenant}.key.pem`)));
  acmeKey = keyOf("acme");
  globexKey = keyOf("globex");
});

interface Claims {
  jti?: string | null;
  iss?: string;
  aud?: string;
  sub?: string;
  tid?: string;
  iat?: number;
  exp?: number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function claims(overrides: Claims = {}): Required<Claims> {
  return { jti: randomUUID(), iss: idpIssuer("acme"), aud: idpAudience("acme"), sub: alice, tid: "acme", iat: nowSeconds(), exp: nowSeconds() + 120, ...overrides };
}

function sign(c: Required<Claims>, key: KeyObject | Uint8Array = acmeKey, alg = "ES256") {
  return new SignJWT({ tid: c.tid, ...(c.jti === null ? {} : { jti: c.jti }) })
    .setProtectedHeader({ alg })
    .setIssuer(c.iss)
    .setAudience(c.aud)
    .setSubject(c.sub)
    .setIssuedAt(c.iat)
    .setExpirationTime(c.exp)
    .sign(key);
}

const sessionCount = () => (rawSqlite().prepare("SELECT count(*) AS n FROM session").get() as { n: number }).n;

/** Asserts the assertion is refused by the validator and by the full sign-in, and that no session row was written. */
async function expectRejected(tenantId: string, assertion: string) {
  const before = sessionCount();
  expect(await verifySsoAssertion(tenantId, assertion)).toBeNull();
  expect(await signInWithSso({ tenantId, assertion, deviceId: "D".repeat(43) })).toBeNull();
  expect(sessionCount()).toBe(before);
}

describe("[L1-20] SSO assertions are validated before any session is created", () => {
  it("accepts a genuine assertion from the tenant's IdP (control case)", async () => {
    const assertion = await sign(claims());
    expect((await verifySsoAssertion("acme", assertion))?.subject).toBe(alice);
    const cookie = await signInWithSso({ tenantId: "acme", assertion, deviceId: "D".repeat(43) });
    expect(readSession(cookie!, "D".repeat(43))).toMatchObject({ tenantId: "acme", email: "alice@acme.test", role: "employee" });
  });

  it("rejects a forged assertion: payload changed after signing", async () => {
    const [header, , signature] = (await sign(claims())).split(".");
    const forgedPayload = base64url.encode(JSON.stringify({ ...claims(), sub: ssoSubjectFor("acme", "bob@acme.test") }));
    await expectRejected("acme", `${header}.${forgedPayload}.${signature}`);
  });

  it("rejects an assertion signed with the wrong key", async () => {
    const attacker = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    await expectRejected("acme", await sign(claims(), attacker));
    // A real key, but another tenant's IdP: still wrong for acme.
    await expectRejected("acme", await sign(claims(), globexKey));
  });

  it("rejects the wrong algorithm: none, HMAC with the public key, and other signature algorithms", async () => {
    const header = base64url.encode(JSON.stringify({ alg: "none", typ: "JWT" }));
    await expectRejected("acme", `${header}.${base64url.encode(JSON.stringify(claims()))}.`);

    // Classic key-confusion attack: HS256 using the IdP's public key (known to anyone) as the HMAC secret.
    const publicPem = rawSqlite().prepare("SELECT signing_cert FROM tenant_idp_config WHERE tenant_id = 'acme'").get() as { signing_cert: string };
    await expectRejected("acme", await sign(claims(), new TextEncoder().encode(publicPem.signing_cert), "HS256"));

    await expectRejected("acme", await sign(claims(), generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey, "ES384"));
    await expectRejected("acme", await sign(claims(), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, "RS256"));
  });

  it("rejects an expired assertion, and one issued too long ago", async () => {
    await expectRejected("acme", await sign(claims({ iat: nowSeconds() - 600, exp: nowSeconds() - 300 })));
    await expectRejected("acme", await sign(claims({ iat: nowSeconds() - 3600, exp: nowSeconds() + 3600 })));
  });

  it("rejects the wrong audience and the wrong issuer", async () => {
    await expectRejected("acme", await sign(claims({ aud: idpAudience("globex") })));
    await expectRejected("acme", await sign(claims({ aud: "urn:some-other-app" })));
    await expectRejected("acme", await sign(claims({ iss: idpIssuer("globex") })));
  });

  it("rejects the wrong tenant", async () => {
    // Signed by acme's IdP, but naming another tenant in the tid claim.
    await expectRejected("acme", await sign(claims({ tid: "globex" })));
    // A genuine globex assertion delivered to acme's callback.
    const globexAssertion = await sign(claims({ iss: idpIssuer("globex"), aud: idpAudience("globex"), sub: dana, tid: "globex" }), globexKey);
    expect((await verifySsoAssertion("globex", globexAssertion))?.subject).toBe(dana); // valid for globex...
    await expectRejected("acme", globexAssertion); // ...but not for acme
    // Correctly signed for acme, but the subject is a globex employee: no such acme user.
    expect(await signInWithSso({ tenantId: "acme", assertion: await sign(claims({ sub: dana })), deviceId: "D".repeat(43) })).toBeNull();
  });

  it("rejects malformed input and unknown tenants without throwing", async () => {
    await expectRejected("acme", "not-a-jwt");
    await expectRejected("acme", "");
    await expectRejected("initech", await sign(claims({ tid: "initech" })));
    await expectRejected("../acme", await sign(claims()));
  });
});

describe("[L1-20 DiD] an assertion can be used only once", () => {
  beforeAll(() => useFakeClock());
  afterAll(() => vi.useRealTimers());

  it("a replayed assertion is rejected, and no second session is created", async () => {
    const assertion = await sign(claims());
    expect(await signInWithSso({ tenantId: "acme", assertion, deviceId: "D".repeat(43) })).not.toBeNull();
    const before = sessionCount();
    expect(await signInWithSso({ tenantId: "acme", assertion, deviceId: "E".repeat(43) })).toBeNull();
    expect(sessionCount()).toBe(before);
  });

  it("a replay is still rejected just before the assertion expires, and the record is purged after", async () => {
    const jti = randomUUID();
    const assertion = await sign(claims({ jti }));
    expect(await signInWithSso({ tenantId: "acme", assertion, deviceId: "D".repeat(43) })).not.toBeNull();
    advance(119 + 29); // inside exp (120 s) plus the 30 s clock tolerance
    expect(await signInWithSso({ tenantId: "acme", assertion, deviceId: "D".repeat(43) })).toBeNull();
    advance(5 * 60); // past every validity window: the assertion itself is now refused as expired
    expect(await verifySsoAssertion("acme", assertion)).toBeNull();
    const recorded = () => (rawSqlite().prepare("SELECT count(*) AS n FROM sso_assertion WHERE assertion_id = ?").get(jti) as { n: number }).n;
    expect(recorded()).toBe(1);
    await signInWithSso({ tenantId: "acme", assertion: await sign(claims()), deviceId: "D".repeat(43) }); // triggers the purge
    expect(recorded()).toBe(0); // no longer needed: the assertion can no longer pass validation anyway
  });

  it("an assertion without an id (jti) is rejected", async () => {
    await expectRejected("acme", await sign(claims({ jti: null })));
  });

  it("a replay through the callback route is turned away", async () => {
    const assertion = await sign(claims());
    expect(location(await new Browser().post(ssoCallbackPOST, "/api/auth/sso/acme/callback", { assertion }, { tenantId: "acme" }))).toBe("/employee");
    const replay = new Browser();
    expect(location(await replay.post(ssoCallbackPOST, "/api/auth/sso/acme/callback", { assertion }, { tenantId: "acme" }))).toBe("/login?error=sso");
    expect(replay.session).toBeUndefined();
  });
});

describe("[L1-20] end to end through the stand-in IdP and the callback route", () => {
  it("IdP sign-in posts a signed assertion that the callback turns into an employee session", async () => {
    const browser = new Browser();
    const idp = await browser.post(idpLoginPOST, "/mock-idp/acme/login", { email: "alice@acme.test", password: seededIdpPassword(SEED_TENANTS[0].employees[0].email) }, { tenantId: "acme" });
    const html = await idp.text();
    expect(html).toContain('action="/api/auth/sso/acme/callback"');
    const assertion = html.match(/name="assertion" value="([^"]+)"/)![1];

    const res = await browser.post(ssoCallbackPOST, "/api/auth/sso/acme/callback", { assertion }, { tenantId: "acme" });
    expect(location(res)).toBe("/employee");
    expect(readSession(browser.session, browser.device)?.role).toBe("employee");
  });

  it("a wrong IdP password gets a generic error and no assertion", async () => {
    const res = await new Browser().post(idpLoginPOST, "/mock-idp/acme/login", { email: "alice@acme.test", password: "wrong" }, { tenantId: "acme" });
    expect(res.status).toBe(303);
    expect(location(res)).toBe("/mock-idp/acme?error=1");
  });

  it("a forged assertion posted to the callback is turned away with no session cookie", async () => {
    const browser = new Browser();
    const res = await browser.post(ssoCallbackPOST, "/api/auth/sso/acme/callback", { assertion: await sign(claims({ tid: "globex" })) }, { tenantId: "acme" });
    expect(location(res)).toBe("/login?error=sso");
    expect(browser.session).toBeUndefined();
  });
});
