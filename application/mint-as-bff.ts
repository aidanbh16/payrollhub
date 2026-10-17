import "server-only";
import { mintServiceToken, type ServiceEndpoint } from "@/services/identity/service-tokens";

// The Next.js application layer's only way to mint service tokens: always as caller "bff" (DV-26). ESLint lets only
// app/ and application/ import this handle, so no backend service can mint a token that claims to be the bff.
export function mintAsBff(endpoint: ServiceEndpoint, tenantId: string): Promise<string> {
  return mintServiceToken({ caller: "bff", endpoint, tenantId });
}
