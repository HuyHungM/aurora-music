import type { ProviderId } from "@/lib/domain";

export class AuroraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuroraError";
  }
}

export class ConfigError extends AuroraError {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.details = details;
  }
}

export class ApiError extends AuroraError {
  readonly status: number;

  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
  }
}

export class ProviderError extends AuroraError {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.providerId = providerId;
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(providerId: ProviderId) {
    super(providerId, `No music provider is registered with id "${providerId}"`);
    this.name = "ProviderNotFoundError";
  }
}

export class ProviderDataError extends ProviderError {
  constructor(providerId: ProviderId, message: string, options?: { cause?: unknown }) {
    super(providerId, message, options);
    this.name = "ProviderDataError";
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(providerId: ProviderId, message: string, options?: { cause?: unknown }) {
    super(providerId, message, options);
    this.name = "ProviderRateLimitError";
  }
}

export class InvalidProviderCredentialsError extends ProviderError {
  constructor(providerId: ProviderId, message: string, options?: { cause?: unknown }) {
    super(providerId, message, options);
    this.name = "InvalidProviderCredentialsError";
  }
}

export class UnsupportedProviderCapabilityError extends ProviderError {
  readonly capability: string;

  constructor(
    providerId: ProviderId,
    capability: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(providerId, message, options);
    this.name = "UnsupportedProviderCapabilityError";
    this.capability = capability;
  }
}

export class MissingResultsError extends AuroraError {
  constructor(message = "Response did not contain a results field") {
    super(message);
    this.name = "MissingResultsError";
  }
}

export class AuthenticationError extends AuroraError {
  constructor(message = "You must be signed in to perform this action") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends AuroraError {
  constructor(message = "You are not allowed to perform this action") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class ResourceNotFoundError extends AuroraError {
  readonly resource: string;

  constructor(message: string, resource = "resource") {
    super(message);
    this.name = "ResourceNotFoundError";
    this.resource = resource;
  }
}

export class ConflictError extends AuroraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConflictError";
  }
}

export function isAuroraError(error: unknown): error is AuroraError {
  return error instanceof AuroraError;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function toLogSafeError(error: unknown, fallback = "Unexpected error"): string {
  if (error instanceof AuroraError) {
    return `${error.name}: ${error.message}`;
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return fallback;
}