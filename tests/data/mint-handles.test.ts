import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// DV-26: each service mints service tokens only as itself. Its handle (mint-as-<caller>.ts) can be imported only from
// inside its own folder, and nothing else may import mintServiceToken. Checked by running the project's ESLint config.

const eslint = new ESLint({ cwd: process.cwd() });

async function mintErrors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message.slice(0, 40));
}

const handles = {
  bff: 'import { mintAsBff } from "@/application/mint-as-bff";\nvoid mintAsBff;\n',
  engine: 'import { mintAsEngine } from "@/services/engine/mint-as-engine";\nvoid mintAsEngine;\n',
  ach: 'import { mintAsAch } from "@/services/ach/mint-as-ach";\nvoid mintAsAch;\n',
  direct: 'import { mintServiceToken } from "@/services/identity/service-tokens";\nvoid mintServiceToken;\n',
};

describe("[L1-19] DV-26: per-service minting handles, enforced by lint", () => {
  it("a service can use its own handle", async () => {
    expect(await mintErrors("services/engine/example.ts", handles.engine)).toEqual([]);
    expect(await mintErrors("app/api/example/route.ts", handles.bff)).toEqual([]);
    expect(await mintErrors("application/example.ts", handles.bff)).toEqual([]);
  });

  it("a service cannot use another service's handle", async () => {
    expect(await mintErrors("services/engine/example.ts", handles.ach)).toHaveLength(1);
    expect(await mintErrors("services/engine/example.ts", handles.bff)).toHaveLength(1);
    expect(await mintErrors("app/api/example/route.ts", handles.engine)).toHaveLength(1);
    expect(await mintErrors("services/approval/example.ts", handles.engine)).toHaveLength(1);
  });

  it("nothing but a handle may call mintServiceToken directly", async () => {
    for (const file of ["services/engine/example.ts", "app/api/example/route.ts", "services/identity/example.ts", "edge/example.ts"]) {
      expect(await mintErrors(file, handles.direct)).toHaveLength(1);
    }
    expect(await mintErrors("services/engine/mint-as-engine.ts", handles.direct)).toEqual([]);
  });
}, 60_000);
