import { parseEnv } from "@/lib/config/env";
import { logger } from "@/lib/diagnostics/logger";

/**
 * Server boot hook (Phase 27). Next.js runs `register()` once when the
 * server process starts (`next dev` / `next start`) — never during builds
 * or in unit tests. Purpose: fail fast on invalid production
 * configuration instead of serving a partially initialized application.
 * Only variable NAMES are ever reported; values stay out of logs.
 */
export async function register(): Promise<void> {
  try {
    const env = parseEnv();
    logger.info("Server starting", {
      event: "server_started",
      database: true,
      authSecret: (env.AUTH_SECRET ?? "") !== "",
      youtube: (env.YOUTUBE_API_KEY ?? "") !== "",
      spotify:
        (env.SPOTIFY_CLIENT_ID ?? "") !== "" &&
        (env.SPOTIFY_CLIENT_SECRET ?? "") !== "",
    });
  } catch (error) {
    logger.error("Invalid server configuration", {
      event: "configuration_error",
      errorCode: "CONFIGURATION_ERROR",
    });
    throw error;
  }
}
