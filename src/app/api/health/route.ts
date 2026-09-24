import { NextResponse } from "next/server";
import { getEnv } from "@/lib/config/env";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
// Prisma over TCP cannot run on the edge runtime; pin Node so a future
// default change can never silently break (or bypass) the database check.
export const runtime = "nodejs";

const DB_CHECK_TIMEOUT_MS = 3000;

type DatabaseState = "up" | "down" | "unknown";
type EnvironmentState = "valid" | "invalid";

interface HealthBody {
  status: "ok" | "degraded" | "error";
  checks: {
    environment: EnvironmentState;
    database: DatabaseState;
  };
}

async function checkDatabase(): Promise<DatabaseState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health-timeout")), DB_CHECK_TIMEOUT_MS);
      }),
    ]);
    return "up";
  } catch {
    return "down";
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Minimal liveness + readiness probe (Phase 27). Semantics:
 * - 200 `ok`: process alive, configuration valid, database reachable.
 * - 503 `degraded`: process alive but not fully ready (bad env or
 *   unreachable database). Providers are intentionally NOT checked:
 *   Aurora is operational while YouTube/Spotify/Deezer are down.
 *
 * Response shape is fixed and minimal: no versions, paths, user data,
 * secrets, or provider details. Safe to expose to load balancers.
 */
export async function GET(): Promise<NextResponse<HealthBody>> {
  let environment: EnvironmentState;
  try {
    getEnv();
    environment = "valid";
  } catch {
    const body: HealthBody = {
      status: "error",
      checks: { environment: "invalid", database: "unknown" },
    };
    return NextResponse.json(body, { status: 503 });
  }

  const database = await checkDatabase();
  const ready = database === "up";
  const body: HealthBody = {
    status: ready ? "ok" : "degraded",
    checks: { environment, database },
  };
  return NextResponse.json(body, { status: ready ? 200 : 503 });
}
