/**
 * Diagnostic-only fetch tap for the v2 CLOB/relayer surfaces. Browser network
 * panels show "400 (Bad Request)" with no body for these endpoints — this
 * reads and prints the actual JSON error so failures are debuggable from the
 * console instead of guessed at. It also prints green OK lines for watched
 * 2xx calls (the auth flow's success half is otherwise invisible) and marks
 * the client's create-then-derive 400 as EXPECTED — verified from the client
 * source: `aE()` catches exactly status 400 from POST /auth/api-key and
 * falls back to GET /auth/derive-api-key. Installed once from main.tsx.
 */

const WATCH = [
  "clob.polymarket.com/auth",
  "clob.polymarket.com/order",
  "relayer-v2.polymarket.com",
];

export function installDebugFetch() {
  if ((window as unknown as { __sentryFetchPatched?: boolean }).__sentryFetchPatched) return;
  (window as unknown as { __sentryFetchPatched?: boolean }).__sentryFetchPatched = true;

  const orig = window.fetch;
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const watched = WATCH.some((w) => url.includes(w));

    // the official client passes Request objects (args[1] === undefined) —
    // read method/body from the Request itself, not just the init
    let method = args[1]?.method;
    let reqBody: unknown = args[1]?.body;
    if (watched && !method && typeof Request !== "undefined" && input instanceof Request) {
      method = input.method;
      try {
        reqBody = await input.clone().text();
      } catch {
        reqBody = "(stream)";
      }
    }
    method = method ?? "GET";

    const res = await orig(...args);
    if (watched) {
      try {
        const body = await res.clone().text();
        const expectedCreate400 =
          url.includes("/auth/api-key") && res.status === 400 && body.includes("Could not create api key");
        if (expectedCreate400) {
          console.info(
            `%c[SENTRY DEBUG] ${method} ${url} → 400 — EXPECTED: creds already exist; the client now derives them (this is not a fault)`,
            "color:#b90",
          );
        } else if (!res.ok) {
          console.error(
            `%c[SENTRY DEBUG] ${method} ${url} → ${res.status}`,
            "color:#f66;font-weight:bold",
            "\nrequest body:",
            reqBody ?? "(none)",
            "\nresponse body:",
            body,
          );
        } else {
          console.info(
            `%c[SENTRY DEBUG] ${method} ${url} → ${res.status} OK`,
            "color:#3a5;font-weight:bold",
          );
        }
      } catch {
        /* body unreadable — skip */
      }
    }
    return res;
  };
}
