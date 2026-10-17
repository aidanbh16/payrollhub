import "server-only";
import { mintServiceToken, type ServiceEndpoint } from "@/services/identity/service-tokens";

// This service's only way to mint service tokens: always as caller "approval" (DV-26). ESLint lets only files inside
// services/approval/ import this handle, so no other module can mint a token that claims to be this service.
export function mintAsApproval(endpoint: ServiceEndpoint, tenantId: string): Promise<string> {
  return mintServiceToken({ caller: "approval", endpoint, tenantId });
}
