import { z } from "zod";

// Shared field schemas. Path parameters are validated like any other input.
export const tenantIdParam = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
export const uuidParam = z.uuid();
