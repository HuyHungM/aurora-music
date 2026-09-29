#!/usr/bin/env node
/**
 * Aurora — YouTube InnerTube egress proxy.
 *
 * A minimal, CONNECT-only forward proxy with Basic auth and a strict host
 * allowlist. Aurora points `AURORA_YOUTUBE_EGRESS_PROXY` at it when the
 * function's own egress is treated as a datacenter by YouTube's anti-bot
 * layer (the player response comes back `LOGIN_REQUIRED` with no
 * `streaming_data`, and every video fails with "No playable audio format
 * available"). See ARCHITECTURE.md §8.
 *
 * SCOPE. Only the InnerTube API hosts are reachable. The googlevideo media
 * CDN is deliberately absent: Aurora probes it from the function and the
 * browser plays it from the user's own IP, so it must never transit here.
 *
 * Configuration (environment):
 *   PORT        listen port                (default 8080)
 *   PROXY_USER  Basic-auth username        (required)
 *   PROXY_PASS  Basic-auth password        (required)
 *
 * Run:  PROXY_USER=... PROXY_PASS=... PORT=8080 node tools/youtube-egress-proxy.mjs
 * Then set Aurora's `AURORA_YOUTUBE_EGRESS_PROXY` to:
 *   http://USER:PASSWORD@HOST:PORT
 */

import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.PORT || 8080);
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;

/** Drop an idle tunnel after this long. Innertube requests are short. */
const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Deliberately narrow: exactly the hosts youtubei.js talks to for discovery
 * and playback. No wildcards, no googlevideo.
 */
const ALLOWED_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtubei.googleapis.com",
]);

if (!PROXY_USER || !PROXY_PASS) {
  console.error(
    JSON.stringify({ event: "proxy_config_error", error: "PROXY_USER and PROXY_PASS must be set" }),
  );
  process.exit(1);
}

function log(fields) {
  // Never include request headers: Proxy-Authorization carries the secret.
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields }));
}

function unauthorized(socket) {
  socket.write(
    "HTTP/1.1 407 Proxy Authentication Required\r\n" +
      'Proxy-Authenticate: Basic realm="Aurora YouTube Proxy"\r\n' +
      "Content-Length: 0\r\n" +
      "Connection: close\r\n\r\n",
  );
  socket.destroy();
}

function forbidden(socket) {
  socket.write(
    "HTTP/1.1 403 Forbidden\r\n" + "Content-Length: 0\r\n" + "Connection: close\r\n\r\n",
  );
  socket.destroy();
}

function isAuthorized(headers) {
  const value = headers["proxy-authorization"];
  if (typeof value !== "string" || !value.startsWith("Basic ")) {
    return false;
  }
  try {
    const decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return false;
    }
    const user = decoded.slice(0, separator);
    const pass = decoded.slice(separator + 1);
    return user === PROXY_USER && pass === PROXY_PASS;
  } catch {
    return false;
  }
}

function allowedHost(hostname) {
  return ALLOWED_HOSTS.has(hostname.toLowerCase());
}

/**
 * CONNECT targets arrive as `host:port` (IPv6 as `[::1]:443`). Split on the
 * last colon so a bare host still defaults to 443.
 */
function parseConnectTarget(target) {
  const index = target.lastIndexOf(":");
  if (index < 0) {
    return { hostname: target, port: 443 };
  }
  return { hostname: target.slice(0, index), port: Number(target.slice(index + 1)) };
}

const server = http.createServer((req, res) => {
  // Tiny liveness probe for uptime monitors; everything else is CONNECT-only.
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("CONNECT-only proxy");
});

server.on("connect", (req, clientSocket, head) => {
  let target;
  try {
    target = parseConnectTarget(req.url ?? "");
  } catch {
    clientSocket.destroy();
    return;
  }

  const authorized = isAuthorized(req.headers);
  const allowed = target.port === 443 && allowedHost(target.hostname);
  log({
    event: "proxy_connect",
    target: `${target.hostname}:${target.port}`,
    authorized,
    allowed,
  });

  if (!authorized) {
    unauthorized(clientSocket);
    return;
  }
  if (!allowed) {
    forbidden(clientSocket);
    return;
  }

  const upstream = net.connect({ host: target.hostname, port: target.port }, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n");
    if (head?.length) {
      upstream.write(head);
    }
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS);
  upstream.on("timeout", () => {
    upstream.destroy();
    clientSocket.destroy();
  });
  upstream.on("error", () => {
    clientSocket.destroy();
  });
  clientSocket.on("error", () => {
    upstream.destroy();
  });
  clientSocket.on("close", () => {
    upstream.destroy();
  });
});

server.on("clientError", (error, socket) => {
  // Malformed client traffic (not a valid HTTP request line). Answer and drop.
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
  socket.destroy();
});

server.listen(PORT, "0.0.0.0", () => {
  log({ event: "proxy_started", port: PORT, allowedHosts: [...ALLOWED_HOSTS] });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log({ event: "proxy_stopping", signal });
    server.close(() => process.exit(0));
    // Do not wait forever for in-flight tunnels.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
