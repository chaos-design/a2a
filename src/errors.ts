import type { ErrorPayload, JsonValue } from "./types.js";

export const ErrorCode = {
  ConfigurationError: "CONFIGURATION_ERROR",
  InvalidMessage: "INVALID_MESSAGE",
  UnsupportedVersion: "UNSUPPORTED_VERSION",
  AuthenticationRequired: "AUTHENTICATION_REQUIRED",
  AuthenticationFailed: "AUTHENTICATION_FAILED",
  AuthorizationDenied: "AUTHORIZATION_DENIED",
  InvalidSignature: "INVALID_SIGNATURE",
  UnknownKey: "UNKNOWN_KEY",
  ReplayDetected: "REPLAY_DETECTED",
  MessageExpired: "MESSAGE_EXPIRED",
  RecipientMismatch: "RECIPIENT_MISMATCH",
  HandlerNotFound: "HANDLER_NOT_FOUND",
  PayloadTooLarge: "PAYLOAD_TOO_LARGE",
  RateLimited: "RATE_LIMITED",
  Conflict: "CONFLICT",
  HandlerFailed: "HANDLER_FAILED",
  TransportFailed: "TRANSPORT_FAILED",
  InternalError: "INTERNAL_ERROR",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class A2AError extends Error {
  readonly code: ErrorCodeValue | (string & {});
  readonly status: number;
  readonly retriable: boolean;
  readonly details?: JsonValue;

  constructor(
    code: ErrorCodeValue | (string & {}),
    message: string,
    options: {
      status?: number;
      retriable?: boolean;
      details?: JsonValue;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "A2AError";
    this.code = code;
    this.status = options.status ?? 500;
    this.retriable = options.retriable ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  toPayload(): ErrorPayload {
    const payload: ErrorPayload = {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
    };
    if (this.details !== undefined) {
      payload.details = this.details;
    }
    return payload;
  }
}

export function asA2AError(error: unknown): A2AError {
  if (error instanceof A2AError) {
    return error;
  }

  return new A2AError(ErrorCode.InternalError, "An internal error occurred", {
    status: 500,
    retriable: true,
    cause: error,
  });
}
