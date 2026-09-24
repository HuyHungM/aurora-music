/**
 * Authenticated E2E cleanup script (Phase 30). Runs under `tsx`.
 * Deletes exactly the synthetic rows and prints leftover artifact
 * counts as JSON for the teardown project to assert on.
 */
import {
  cleanupAuthTestData,
  closeTestClient,
  countAuthTestArtifacts,
} from "./db";

try {
  await cleanupAuthTestData();
  const counts = await countAuthTestArtifacts();
  await closeTestClient();
  console.log(JSON.stringify(counts));
} catch (error) {
  await closeTestClient().catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
