import { MissingResultsError } from "@/lib/errors";

export interface ApiListEnvelope<T> {
  results?: T;
  total?: number;
  offset?: number;
  limit?: number;
  next?: string | null;
}

export function unwrapResults<T>(
  envelope: ApiListEnvelope<T>,
  errorMessage = "Response did not contain a results field",
): T {
  if (envelope.results === undefined) {
    throw new MissingResultsError(errorMessage);
  }
  return envelope.results;
}