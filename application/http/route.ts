import "server-only";
import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AuthError, requireSession } from "@/application/auth/dal";
import {
  ApprovalRejectedError, BankRejectedError, BankUnavailableError, ConflictError, InvalidInputError, NotFoundError, RunFailedError, ServiceAuthError, StepUpRequiredError,
} from "@/services/errors";
import { verifyServiceToken, type ServiceClaims, type ServiceEndpoint } from "@/services/identity/service-tokens";
import type { Role, SessionClaims } from "@/services/identity/sessions";
import { isSameOrigin } from "./forms";
import { log } from "@/data/log/logger";

// The one route-handler pattern (Assignment 5, Section 2.3). Every route under app/ exports its handlers through
// route.session(), route.service(), or route.public(); ESLint and tests/data/route-wrapper.test.ts reject anything else.
// In order, the wrapper:
//   1. refuses cross-origin form posts (session and public routes);
//   2. authenticates: a session with an allowed role, or a scoped service token for one endpoint;
//   3. if the path has [tenantId], refuses the request when it differs from the verified tenant (L2-04): never corrects it;
//   4. validates path params, query, and body with strict Zod schemas, so unknown fields (tenantId included) are
//      rejected rather than dropped;
//   5. calls the handler with the verified claims and the verified tenantId;
//   6. maps every error to a fixed, generic response. Stack traces, SQL, and internal messages stay in the server log.

type StrictSchema = z.ZodObject;
const EMPTY = z.strictObject({});
type Empty = typeof EMPTY;

type Json = Record<string, unknown> | unknown[];
type Result = Response | Json;
type RawParams = Record<string, string | string[] | undefined>;

/** The signature Next.js calls. */
export type RouteHandler = (request: NextRequest, ctx: { params: Promise<RawParams> }) => Promise<Response>;

/** For handlers: a deliberate, client-safe error response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

interface Inputs<P extends StrictSchema, Q extends StrictSchema, B extends StrictSchema> {
  /** Path parameters other than [tenantId]. */
  params?: P;
  query?: Q;
  body?: { type: "json" | "form"; schema: B };
}

interface BaseContext<P extends StrictSchema, Q extends StrictSchema, B extends StrictSchema> {
  request: NextRequest;
  requestId: string;
  params: z.infer<P>;
  query: z.infer<Q>;
  body: z.infer<B>;
}

type Handler<C> = (ctx: C) => Promise<Result> | Result;

// ---------- definition-time checks: a misconfigured route fails when its module loads ----------

function requireStrict(where: string, schema: unknown, allowTenantParam = false): asserts schema is StrictSchema {
  const strict = schema instanceof z.ZodObject && (schema.def.catchall as z.ZodType | undefined)?.def.type === "never";
  if (!strict) throw new Error(`${where} must be a z.strictObject, so unknown fields are rejected rather than dropped`);
  for (const key of Object.keys(schema.shape)) {
    if (/tenant/i.test(key) && !(allowTenantParam && key === "tenantId")) {
      throw new Error(`${where} must not accept "${key}": the tenant comes only from verified claims`);
    }
  }
}

function checkInputs(inputs: Inputs<StrictSchema, StrictSchema, StrictSchema>, allowTenantParam = false) {
  if (inputs.params) requireStrict("params schema", inputs.params, allowTenantParam);
  if (inputs.query) requireStrict("query schema", inputs.query);
  if (inputs.body) requireStrict("body schema", inputs.body.schema);
}

// ---------- request handling ----------

async function readBody(request: NextRequest, type: "json" | "form"): Promise<unknown> {
  try {
    return type === "json" ? await request.json() : Object.fromEntries(await request.formData());
  } catch {
    throw new HttpError(400, "Invalid request body");
  }
}

async function parseInputs(request: NextRequest, raw: RawParams, inputs: Inputs<StrictSchema, StrictSchema, StrictSchema>) {
  return {
    params: (inputs.params ?? EMPTY).parse(raw),
    query: (inputs.query ?? EMPTY).parse(Object.fromEntries(request.nextUrl.searchParams)),
    body: inputs.body ? inputs.body.schema.parse(await readBody(request, inputs.body.type)) : {},
  };
}

/** Maps any error to a fixed, generic response. Exported for handlers that must add headers (e.g. a rotated cookie). */
export function errorResponse(err: unknown, requestId: string): NextResponse {
  const json = (status: number, body: Json) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (err instanceof AuthError) return json(err.status, { error: err.message });
  if (err instanceof ServiceAuthError) {
    log.warn("api.service_auth_rejected", { requestId, reason: err.message });
    return json(401, { error: "Service authentication failed" });
  }
  if (err instanceof HttpError) return json(err.status, { error: err.publicMessage });
  if (err instanceof NotFoundError) return json(404, { error: "Not found" });
  if (err instanceof InvalidInputError) return json(400, { error: err.message });
  if (err instanceof ConflictError) return json(409, { error: err.message });
  if (err instanceof RunFailedError) {
    const error = err.reason === "bank_account_changed" ? "A bank account changed after this run was computed; create a new run" : "Payroll run failed and must be approved again";
    return json(409, { error, reason: err.reason });
  }
  if (err instanceof BankRejectedError) {
    log.warn("api.bank_rejected_batch", { requestId, reason: err.reason });
    return json(502, { error: "The bank rejected the batch", reason: err.reason });
  }
  if (err instanceof BankUnavailableError) {
    log.warn("api.bank_unavailable", { requestId, reason: err.reason });
    return json(504, { error: "The bank did not answer. Send again: the same batch is resent, never a new one." });
  }
  if (err instanceof StepUpRequiredError) return json(403, { error: "Step-up verification failed" });
  if (err instanceof ApprovalRejectedError) {
    log.warn("api.approval_token_rejected", { requestId, reason: err.message });
    return json(403, { error: "Approval token rejected" });
  }
  if (err instanceof z.ZodError) {
    // Field paths and Zod's own messages only; submitted values are never echoed back.
    return json(400, { error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  log.error("api.unhandled_error", { requestId, error: err });
  return json(500, { error: "Internal error", requestId });
}

function finish(result: Result, requestId: string): Response {
  const res = result instanceof Response ? result : NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  res.headers.set("X-Request-Id", requestId);
  return res;
}

function wrap(run: (request: NextRequest, raw: RawParams, requestId: string) => Promise<Result>): RouteHandler {
  return async (request, ctx) => {
    const requestId = randomUUID();
    try {
      return finish(await run(request, { ...(await ctx.params) }, requestId), requestId);
    } catch (err) {
      // Next.js signals redirects, not-found, and prerender bail-outs by throwing; those must reach Next.js untouched.
      // (Reading cookies, headers, or the query during a build-time prerender throws such a bail-out, which is how
      // Next.js learns that the route is dynamic. Swallowing it would turn it into a cached 500.)
      unstable_rethrow(err);
      const res = errorResponse(err, requestId);
      res.headers.set("X-Request-Id", requestId);
      return res;
    }
  };
}

function refuseCrossOrigin(request: NextRequest) {
  if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request)) {
    throw new HttpError(403, "Cross-origin request refused");
  }
}

/** Takes [tenantId] out of the raw params so it can only be compared, never used. */
function takePathTenant(raw: RawParams, tenantInPath: boolean): string | undefined {
  if (!tenantInPath) return undefined;
  const value = raw.tenantId;
  delete raw.tenantId;
  if (typeof value !== "string") throw new Error("Route declares tenantInPath but its path has no [tenantId]");
  return value;
}

function requireSameTenant(tenantInPath: boolean, pathTenant: string | undefined, verifiedTenant: string) {
  if (tenantInPath && pathTenant !== verifiedTenant) throw new HttpError(403, "Forbidden");
}

// ---------- the three entry points ----------

/** A route for signed-in users. The handler receives verified session claims and the verified tenantId. */
function session<P extends StrictSchema = Empty, Q extends StrictSchema = Empty, B extends StrictSchema = Empty>(
  spec: Inputs<P, Q, B> & {
    roles: readonly Role[];
    /** The path contains [tenantId]; it must equal the session's tenant or the request is refused with 403. */
    tenantInPath?: boolean;
    handler: Handler<BaseContext<P, Q, B> & { session: SessionClaims; tenantId: string }>;
  },
): RouteHandler {
  checkInputs(spec);
  if (spec.roles.length === 0) throw new Error("route.session needs at least one role");
  return wrap(async (request, raw, requestId) => {
    refuseCrossOrigin(request);
    const pathTenant = takePathTenant(raw, spec.tenantInPath ?? false);
    const claims = requireSession(request.cookies, spec.roles);
    requireSameTenant(spec.tenantInPath ?? false, pathTenant, claims.tenantId);
    const inputs = await parseInputs(request, raw, spec);
    return spec.handler({ request, requestId, ...inputs, session: claims, tenantId: claims.tenantId } as never);
  });
}

/**
 * An internal route (/api/internal/*) for service-to-service calls (D6). It accepts only a scoped service token in
 * "Authorization: Bearer", minted for exactly this endpoint; session cookies are ignored.
 */
function service<P extends StrictSchema = Empty, Q extends StrictSchema = Empty, B extends StrictSchema = Empty>(
  spec: Inputs<P, Q, B> & {
    endpoint: ServiceEndpoint;
    tenantInPath: boolean;
    /** Pass `service` to the service function: it is the verified (and, if single-use, already consumed) call. */
    handler: Handler<BaseContext<P, Q, B> & { service: ServiceClaims; tenantId: string }>;
  },
): RouteHandler {
  checkInputs(spec);
  return wrap(async (request, raw, requestId) => {
    const pathTenant = takePathTenant(raw, spec.tenantInPath);
    const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const claims = await verifyServiceToken(token, { endpoint: spec.endpoint, tenantId: pathTenant });
    requireSameTenant(spec.tenantInPath, pathTenant, claims.tenantId);
    const inputs = await parseInputs(request, raw, spec);
    return spec.handler({ request, requestId, ...inputs, service: claims, tenantId: claims.tenantId } as never);
  });
}

/**
 * A route that needs no session: sign-in, logout, and the SSO flow. It still gets origin checks, strict validation,
 * and generic errors. Its params may include tenantId only to choose which tenant's sign-in to run; that value is
 * never treated as verified.
 */
function publicRoute<P extends StrictSchema = Empty, Q extends StrictSchema = Empty, B extends StrictSchema = Empty>(
  spec: Inputs<P, Q, B> & { handler: Handler<BaseContext<P, Q, B>> },
): RouteHandler {
  checkInputs(spec, true);
  return wrap(async (request, raw, requestId) => {
    refuseCrossOrigin(request);
    const inputs = await parseInputs(request, raw, spec);
    return spec.handler({ request, requestId, ...inputs } as never);
  });
}

export const route = { session, service, public: publicRoute };
