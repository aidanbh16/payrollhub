import "server-only";
import { mintServiceToken, type ServiceEndpoint } from "@/services/identity/service-tokens";

// This service's only way to mint service tokens: always as caller "engine" (DV-26). ESLint lets only files inside
// services/engine/ import this handle, so no other module can mint a token that claims to be this service.
export function mintAsEngine(endpoint: ServiceEndpoint, tenantId: string): Promise<string> {
  return mintServiceToken({ caller: "engine", endpoint, tenantId });
}
