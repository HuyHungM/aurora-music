/**
 * The one version number for Aurora's client-facing contract (Phase 52, RULE 27).
 *
 * There is deliberately no `/api/v1` URL prefix. Aurora's client surface is
 * React Server Components plus server actions, not a REST API; prefixing every
 * route would be a migration of working code for a convention no client needs
 * (RULE 27: "only stabilize the client-facing surface"). A native wrapper talks
 * to `/api/app-config` and to the same https paths a browser already uses, so
 * the version belongs in the payload, where a client can actually read it and
 * pin the shape it understands.
 *
 * Two independent numbers exist and must not be conflated:
 * - `API_CONTRACT_VERSION` (here): the shape of the client-facing payloads.
 * - `APP_CONFIG_API_VERSION` (in the app-config route): the shape of that one
 *   endpoint's body, which is a strict subset.
 *
 * Bump rules: additive, optional fields do not bump; removing a field, renaming
 * one, or changing a type does.
 */
export const API_CONTRACT_VERSION = "v1";
