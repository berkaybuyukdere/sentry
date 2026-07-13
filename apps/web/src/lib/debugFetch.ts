/**
 * Diagnostic-only fetch tap for the v2 CLOB/relayer surfaces. Browser network
 * panels show "400 (Bad Request)" with no body for these endpoints (opaque
 * CORS-safe responses in some Chrome configs) — this reads and prints the
 * actual JSON error so failures are debuggable from the console instead of
 * guessed at. Installed once from main.tsx; no behavior change, read-only.
 */

const WATCH = ["clob.polymarket.com/auth", "relayer-v2.polymarket.com/submit", "relayer-v2.polymarket.com"];

export function installDebugFetch() {
  if ((window as unknown as { __sentryFetchPatched?: boolean }).__sentryFetchPatched) return;
  (window as unknown as { __sentryFetchPatched?: boolean }).__sentryFetchPatched = true;

  const orig = window.fetch;
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const url = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].href : (args[0] as Request).url;
    const watched = WATCH.some((w) => url.includes(w));
    const res = await orig(...args);
    if (watched && !res.ok) {
      try {
        const clone = res.clone();
        const body = await clone.text();
        const init = args[1];
        console.error(
          `%c[SENTRY DEBUG] ${init?.method ?? "GET"} ${url} → ${res.status}`,
          "color:#f66;font-weight:bold",
          "\nrequest body:",
          init?.body ?? "(none)",
          "\nresponse body:",
          body,
        );
      } catch {
        console.error(`[SENTRY DEBUG] ${url} → ${res.status} (body unreadable)`);
      }
    }
    return res;
  };
}
