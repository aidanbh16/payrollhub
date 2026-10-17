// Cookie names, kept free of imports so proxy.ts can use them without pulling in database code.
// The __Host- prefix makes the browser require Secure and Path=/ and refuse a Domain attribute, so a sibling
// subdomain cannot plant or overwrite these cookies. Browsers treat http://localhost as a secure context.
export const SESSION_COOKIE = "__Host-ph_session";
export const DEVICE_COOKIE = "__Host-ph_device";
