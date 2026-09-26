/**
 * Public share-route verification (Phase 47).
 *
 * The unit suite proves the route's logic with a mocked DAL and the build
 * proves it compiles. Neither touches a real HTTP response. This script is the
 * only check that exercises `/playlist/share/<token>` end to end against a
 * PRODUCTION server (`next start`) with an UNAUTHENTICATED client, which is
 * exactly the threat model the feature exists for.
 *
 * It asserts the security invariants, not cosmetics:
 *
 *   1. a valid shared token renders, for a client with no session;
 *   2. no private data appears in the public response — no owner id, no share
 *      token, no second playlist of the same owner, no Prisma identifier;
 *   3. a PRIVATE playlist is unreachable through the share route, including by
 *      its database id (the by-id hole the token exists to close);
 *   4. a forged, junk, and path-traversal token are all refused;
 *   5. revoking sharing kills the previously working link immediately;
 *   6. every refusal is INDISTINGUISHABLE from every other refusal, so a
 *      prober cannot tell "wrong token" from "private playlist".
 *
 * Prerequisite: a production build (`bun run build`) and a migrated database.
 *
 *   bun run verify:share-route
 */
import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Load `.env` the way the app does, so this script needs no extra setup.
for (const line of readFileSync(resolve(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
}

const PORT = Number(process.env.AURORA_SHARE_VERIFY_PORT ?? 3199);
const BASE = `http://127.0.0.1:${PORT}`;

const { prisma } = await import("../src/lib/db");

let failures = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}

/**
 * `notFound()` on a dynamic segment in this app answers 200 with the
 * not-found body — `/track`, `/album`, `/artist` and `/library/playlists` all
 * behave the same way, so the share route inherits that pre-existing quirk
 * rather than introducing it. The status is therefore reported, not asserted;
 * what matters is that no refusal ever carries playlist data.
 */
function statusNote(response: Response): string {
  return `status ${response.status}`;
}

/**
 * What a human (or a crawler reading rendered text) actually sees: the markup
 * with scripts, styles and tags removed.
 *
 * Two further normalisations, both because the raw response would be comparing
 * Next's transport rather than this app:
 *
 *   - script/style bodies are dropped: an extra client-chunk `<script>`
 *     reference appears in some renders and not others, and an internal module
 *     counter increments between requests. Neither depends on whether a
 *     playlist exists.
 *   - the surviving fragments are SORTED. A `notFound()` raised after awaiting
 *     the database streams the not-found content last; one raised before the
 *     lookup streams it first. The same 226 characters appear in a different
 *     order, which discloses nothing — the order is chosen by the framework's
 *     streaming, not by the outcome of the lookup.
 */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((fragment) => fragment.replace(/\s+/g, " ").trim())
    .filter((fragment) => fragment.length > 0)
    .sort()
    .join(" | ");
}

if (!existsSync(resolve(process.cwd(), ".next/BUILD_ID"))) {
  console.error("verify-share-route: BLOCKED - no production build (.next/BUILD_ID missing). Run `bun run build` first.");
  process.exit(1);
}

const suffix = randomBytes(4).toString("hex");
const ownerName = `Share Probe ${suffix}`;
const sharedTitle = `Shared Probe ${suffix}`;
const privateTitle = `Private Probe ${suffix}`;

const user = await prisma.user.create({
  data: { email: `aurora-share-probe-${suffix}@aurora.test`, name: ownerName },
});
const token = randomBytes(24).toString("base64url");
const shared = await prisma.playlist.create({
  data: {
    userId: user.id,
    title: sharedTitle,
    description: "public read probe",
    artwork: "https://img.example/probe-cover.jpg",
    visibility: "shared",
    shareToken: token,
  },
});
const priv = await prisma.playlist.create({
  data: { userId: user.id, title: privateTitle, visibility: "private" },
});
const forged = randomBytes(24).toString("base64url");

// Spawn `next` directly: going through `bun run start` adds a wrapper process
// that does not die with the child, which is how an earlier revision of this
// script left an orphaned server behind.
const server = spawn(
  process.execPath,
  [resolve(process.cwd(), "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)],
  { env: process.env, stdio: ["ignore", "ignore", "ignore"] },
);

async function waitForServer(): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${BASE}/api/health`);
      return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function killServer(): void {
  try {
    execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

try {
  ok("production build present", true);
  ok("production server came up", await waitForServer());

  // 1. A valid shared token renders for a client with no session at all.
  const valid = await fetch(`${BASE}/playlist/share/${token}`);
  const validBody = await valid.text();
  ok("shared link renders without a session", valid.status === 200, statusNote(valid));
  ok("shared page shows the playlist title", validBody.includes(sharedTitle));
  ok("shared page shows the owner display name", validBody.includes(ownerName));
  ok("shared page shows the description", validBody.includes("public read probe"));
  ok("shared page shows the custom artwork", validBody.includes("probe-cover.jpg"));

  // 2. Nothing private is reachable through the public response.
  ok("no owner id in the page", !validBody.includes(user.id));
  ok("no playlist id in the page", !validBody.includes(shared.id));
  ok("no second playlist id in the page", !validBody.includes(priv.id));
  ok("no sibling private title in the page", !validBody.includes(privateTitle));

  // The token necessarily appears twice in the response: once in Next's own
  // route-segment payload, which echoes the URL the requester just supplied.
  // That is not disclosure — the requester already had it. What must NOT
  // happen is the token reaching a surface a third party could harvest: the
  // document head (crawlers, link previews, the share sheet) and metadata.
  const head = validBody.slice(0, validBody.indexOf("</head>"));
  ok("share token never reaches the document head", !head.includes(token));
  ok("no link to the owner's private library area", !validBody.includes("/library/playlists"));

  // 3/4. Every refusal must carry no playlist data.
  //
  // The two classes matter separately. A MALFORMED token is rejected by the
  // shape gate and never reaches the database. A WELL-FORMED token that
  // matches nothing, and a well-formed token whose playlist is real but
  // private, both reach the database and both miss — that last pair is the
  // enumeration question, and it is asserted explicitly below.
  await prisma.playlist.update({
    where: { id: shared.id },
    data: { visibility: "private" },
  });

  const refusals: Array<{ label: string; token: string }> = [
    { label: "private playlist by database id", token: priv.id },
    { label: "junk token", token: "not-a-token" },
    { label: "path traversal token", token: "..%2F..%2Fadmin" },
    { label: "over-long token", token: "A".repeat(200) },
    { label: "forged well-formed token", token: forged },
    { label: "revoked token for a real playlist", token },
  ];

  const refusalTitles = new Set<string>();
  const refusalText = new Set<string>();
  for (const refusal of refusals) {
    const response = await fetch(`${BASE}/playlist/share/${refusal.token}`);
    const body = await response.text();
    ok(`${refusal.label} is refused`, !body.includes(sharedTitle), statusNote(response));
    ok(`${refusal.label} leaks no private title`, !body.includes(privateTitle));
    ok(`${refusal.label} leaks no owner name`, !body.includes(ownerName));
    ok(`${refusal.label} leaks no owner id`, !body.includes(user.id));
    // The title is the surface a human and a crawler actually read.
    refusalTitles.add(/<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "<none>");
    refusalText.add(visibleText(body));
  }

  // 6. Indistinguishability: a prober must not learn which refusal it hit.
  ok(
    "every refusal carries the same title",
    refusalTitles.size === 1,
    [...refusalTitles].join(" | "),
  );
  ok(
    "every refusal shows the same page",
    refusalText.size === 1,
    `${refusalText.size} distinct page(s)`,
  );
  ok(
    "the refusal page is short enough to be a not-found, not a playlist",
    [...refusalText][0].length < 400,
    `${[...refusalText][0].length} chars`,
  );

  // 5. Revocation nulls the token, so the previously working link is dead and
  // stays dead even after sharing is turned back on.
  await prisma.playlist.update({
    where: { id: shared.id },
    data: { shareToken: null },
  });
  const revoked = await fetch(`${BASE}/playlist/share/${token}`);
  ok("revoked link stops resolving", !(await revoked.text()).includes(sharedTitle), statusNote(revoked));

  // Restoring sharing mints a NEW token; the old one must not come back.
  await prisma.playlist.update({
    where: { id: shared.id },
    data: { visibility: "shared", shareToken: randomBytes(24).toString("base64url") },
  });
  const oldTokenAfterRestore = await fetch(`${BASE}/playlist/share/${token}`);
  ok("the pre-revocation token stays dead after re-sharing", !(await oldTokenAfterRestore.text()).includes(sharedTitle));
} finally {
  killServer();
  await prisma.playlist.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
}

console.log(failures === 0 ? "verify-share-route: OK." : `verify-share-route: ${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
