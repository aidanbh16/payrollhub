import { NextRequest } from "next/server";
import { generateSync } from "otplib";
import { vi } from "vitest";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as mfaPOST } from "@/app/api/auth/mfa/route";
import { DEVICE_COOKIE, SESSION_COOKIE } from "@/application/auth/cookie-names";

// Drives route handlers the way a browser would: keeps a cookie jar, sends a same-origin Origin header, and posts
// urlencoded forms. Handlers are called directly, without a running server.

export const ORIGIN = "http://localhost:3000";

type Params = Record<string, string>;
type Handler<P extends Params> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response> | Response;

export class Browser {
  readonly jar = new Map<string, string>();

  private headers(extra: Record<string, string> = {}) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    return { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...extra };
  }

  private absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((p) => p.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = decodeURIComponent(pair.slice(eq + 1));
      if (attrs.some((a) => /^max-age=0$/i.test(a)) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async post<P extends Params>(handler: Handler<P>, path: string, form: Record<string, string>, params = {} as P, headers: Record<string, string> = {}) {
    const req = new NextRequest(new URL(path, ORIGIN), {
      method: "POST",
      body: new URLSearchParams(form),
      headers: this.headers({ "content-type": "application/x-www-form-urlencoded", ...headers }),
    });
    const res = await handler(req, { params: Promise.resolve(params) });
    this.absorb(res);
    return res;
  }

  async json<P extends Params>(handler: Handler<P>, path: string, body: unknown, params = {} as P) {
    const req = new NextRequest(new URL(path, ORIGIN), {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: this.headers({ "content-type": "application/json" }),
    });
    const res = await handler(req, { params: Promise.resolve(params) });
    this.absorb(res);
    return res;
  }

  async get<P extends Params>(handler: Handler<P>, path: string, params = {} as P) {
    const res = await handler(new NextRequest(new URL(path, ORIGIN), { headers: this.headers() }), { params: Promise.resolve(params) });
    this.absorb(res);
    return res;
  }

  request(path: string) {
    return new NextRequest(new URL(path, ORIGIN), { headers: this.headers() });
  }

  get session() {
    return this.jar.get(SESSION_COOKIE);
  }

  get device() {
    return this.jar.get(DEVICE_COOKIE);
  }

  /** This browser's cookies as a Cookie header, for requests built by hand (e.g. straight to Proxy). */
  get cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export const location = (res: Response) => new URL(res.headers.get("location") ?? "", ORIGIN).pathname + new URL(res.headers.get("location") ?? "", ORIGIN).search;

/** Current TOTP code for a secret at the (possibly faked) current time. */
export const totpNow = (secret: string) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) });

/** Fakes only Date, so TOTP steps and session expiry can be moved forward while timers and scrypt run normally. */
export function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T15:00:00Z"));
}

/** Moves the fake clock forward. Logging the same user in again needs a new TOTP step (30 s). */
export function advance(seconds: number): void {
  vi.setSystemTime(new Date(Date.now() + seconds * 1000));
}

export async function staffLogin(browser: Browser, organization: string, email: string, password: string, totpSecret: string) {
  const step1 = await browser.post(loginPOST, "/api/auth/login", { organization, email, password });
  const pending = browser.session;
  const step2 = await browser.post(mfaPOST, "/api/auth/mfa", { code: totpNow(totpSecret) });
  return { step1, pending, step2 };
}
