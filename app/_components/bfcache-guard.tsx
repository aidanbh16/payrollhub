"use client";

import { useEffect } from "react";

// After sign-out, the back button must not show a signed-in page from memory. Pages are Cache-Control: no-store, which
// keeps them out of the HTTP cache; this also covers the browser's back-forward cache: a page restored from it is
// reloaded, which sends the request to the server, where a signed-out visitor is sent to sign-in.
export function BfcacheGuard() {
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
  return null;
}
