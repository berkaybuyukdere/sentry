import Fastify from "fastify";
import cors from "@fastify/cors";

/**
 * SENTRY app backend — scaffold.
 *
 * v1 of the terminal runs fully client-side against Polymarket's public APIs.
 * This service is the designated home for the capabilities that must not live
 * in a browser:
 *   - user accounts + server-persisted watchlists/strategies/rules
 *   - push notification delivery (rule triggers while the terminal is closed)
 *   - API-key shielding / rate-limit pooling if Polymarket tightens limits
 *
 * Endpoints are stubbed deliberately — see the project plan §4 (Backend/services).
 */

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/health", async () => ({
  status: "OPERATIONAL",
  service: "sentry-api",
  ts: new Date().toISOString(),
}));

// Reserved route groups (documented intent, not yet implemented):
app.get("/v1/*", async (_req, reply) =>
  reply.code(501).send({ error: "NOT_IMPLEMENTED", note: "See project plan — app backend phase." }),
);

const port = Number(process.env.PORT ?? 8791);
await app.listen({ port, host: "0.0.0.0" });
