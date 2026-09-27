// Throwaway probe: how does pg resolve SSL when BOTH connectionString and ssl are given?
const { Client } = require("pg");

function sslOf(config) {
  try {
    const c = new Client(config);
    return c.connectionParameters.ssl;
  } catch (e) {
    return "ERR: " + e.message;
  }
}

const base = "postgresql://u:p@h:5432/d";
const cases = [
  ["1 require + ssl.ca", `${base}?sslmode=require`, { ca: "CA_MARKER" }],
  ["2 (none) + ssl.ca", base, { ca: "CA_MARKER" }],
  ["3 require only", `${base}?sslmode=require`, undefined],
  ["4 (none) only", base, undefined],
  ["5 no-verify", `${base}?sslmode=no-verify`, undefined],
  ["6 disable", `${base}?sslmode=disable`, undefined],
  ["7 verify-full only", `${base}?sslmode=verify-full`, undefined],
  ["8 require + ssl object with ca+rejectUnauthorized", `${base}?sslmode=require`, { ca: "CA_MARKER", rejectUnauthorized: true }],
];

for (const [label, cs, ssl] of cases) {
  const cfg = { connectionString: cs };
  if (ssl !== undefined) cfg.ssl = ssl;
  console.log(label, "->", JSON.stringify(sslOf(cfg)));
}
