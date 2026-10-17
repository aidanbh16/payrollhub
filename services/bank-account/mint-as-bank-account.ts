import "server-only";
import { mintServiceToken, type ServiceEndpoint } from "@/services/identity/service-tokens";

// This service's only way to mint service tokens: always as caller "bank-account" (DV-26). ESLint lets only files inside
// services/bank-account/ import this handle, so no other module can mint a token that claims to be this service.
export function mintAsBankAccount(endpoint: ServiceEndpoint, tenantId: string): Promise<string> {
  return mintServiceToken({ caller: "bank-account", endpoint, tenantId });
}
