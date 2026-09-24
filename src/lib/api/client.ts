import { ApiError, toLogSafeError } from "@/lib/errors";
import type { ApiListEnvelope } from "./response";
import { unwrapResults } from "./response";

export interface HttpErrorBody {
  message?: string;
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new ApiError(0, `Request to ${url} failed: ${toLogSafeError(cause)}`, { cause });
  }
  if (!response.ok) {
    throw await httpErrorFromResponse(response, url);
  }
  return (await response.json()) as T;
}

export async function getList<T>(url: string, init?: RequestInit): Promise<T> {
  const envelope = await getJson<ApiListEnvelope<T>>(url, init);
  return unwrapResults(envelope);
}

export async function postJson<TBody, TResponse>(
  url: string,
  body: TBody,
  init?: RequestInit,
): Promise<TResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
  } catch (cause) {
    throw new ApiError(0, `Request to ${url} failed: ${toLogSafeError(cause)}`, { cause });
  }
  if (!response.ok) {
    throw await httpErrorFromResponse(response, url);
  }
  return (await response.json()) as TResponse;
}

async function httpErrorFromResponse(response: Response, url: string): Promise<ApiError> {
  let detail = "";
  try {
    const body = (await response.json()) as HttpErrorBody;
    detail = body.message ?? "";
  } catch {
    detail = "";
  }
  const message = [
    `Request to ${url} failed with status ${response.status}`,
    detail,
  ]
    .filter(Boolean)
    .join(": ");
  return new ApiError(response.status, message);
}