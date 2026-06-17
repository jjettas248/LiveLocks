// Post-login redirect target read from the ?returnTo= query param. Accepts only
// same-origin app paths (leading "/", not "//", not the auth page itself) to
// avoid open-redirect abuse. Shared by the router (which sets it) and the auth
// page (which honors it after a successful login).
export function safeReturnTo(): string | null {
  try {
    const rt = new URLSearchParams(window.location.search).get("returnTo");
    if (rt && rt.startsWith("/") && !rt.startsWith("//") && !rt.startsWith("/auth")) return rt;
  } catch {}
  return null;
}
