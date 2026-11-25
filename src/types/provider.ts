import {
  DomainError,
  type FailureDefinition,
  type RetryGuidance,
} from "../shared/errors.js";
import type { ConnectorJson } from "./catalog.js";

export interface ConnectorProviderBinding {
  accountId: string;
  subjectId: string;
  toolkit: string;
  authConfigurationId: string;
}

export interface ConnectorProviderAccount {
  binding: ConnectorProviderBinding;
  state: "pending" | "active" | "reconnect_required" | "failed";
}

export type ConnectorProviderCompletion =
  "not_started" | "rejected" | "outcome_unknown";
const failures = {
  connector_provider_request_invalid: {
    category: "invalid_input",
    retry: { strategy: "after_change" },
  },
  connector_provider_cancelled: {
    category: "conflict",
    retry: { strategy: "after_change" },
  },
  connector_provider_authentication: {
    category: "unavailable",
    retry: { strategy: "after_change" },
  },
  connector_provider_rejected: {
    category: "invalid_input",
    retry: { strategy: "after_change" },
  },
  connector_provider_rate_limited: {
    category: "rate_limited",
    retry: { strategy: "after_delay", afterSeconds: 30 },
  },
  connector_provider_unavailable: {
    category: "unavailable",
    retry: { strategy: "after_delay", afterSeconds: 30 },
  },
  connector_provider_invalid_response: {
    category: "unavailable",
    retry: { strategy: "after_change" },
  },
  connector_provider_unknown_outcome: {
    category: "unavailable",
    retry: { strategy: "reconcile" },
  },
  connector_account_mismatch: {
    category: "forbidden",
    retry: { strategy: "never" },
  },
} as const satisfies Record<string, FailureDefinition>;

export type ConnectorProviderFailureCode = keyof typeof failures;
export interface ConnectorProviderFailure {
  code: ConnectorProviderFailureCode;
  message: string;
  retry: RetryGuidance;
  completion: ConnectorProviderCompletion;
}
export class ConnectorProviderError extends DomainError<ConnectorProviderFailureCode> {
  constructor(
    code: ConnectorProviderFailureCode,
    message: string,
    readonly completion: ConnectorProviderCompletion,
    afterSeconds?: number,
  ) {
    const definition: FailureDefinition =
      completion === "outcome_unknown"
        ? { category: "unavailable", retry: { strategy: "reconcile" } }
        : afterSeconds === undefined
          ? failures[code]
          : {
              category: failures[code].category,
              retry: { strategy: "after_delay", afterSeconds },
            };
    super(code, definition, message);
  }
  failure(): ConnectorProviderFailure {
    return {
      code: this.code,
      message: this.message,
      retry: this.retry,
      completion: this.completion,
    };
  }
}

export type ConnectorProviderExecution =
  | {
      status: "succeeded";
      result:
        | { kind: "inline"; data: ConnectorJson }
        | { kind: "unavailable"; reason: "invalid_result" };
    }
  | {
      status: "rejected" | "outcome_unknown";
      failure: ConnectorProviderFailure;
    };

export interface ConnectorProvider {
  resolveManagedAuthConfiguration(
    toolkit: string,
    signal: AbortSignal,
  ): Promise<string>;
  createSetup(
    input: {
      authConfigurationId: string;
      subjectId: string;
    },
    signal: AbortSignal,
  ): Promise<{ accountId: string; connectUrl: string; expiresAt: string }>;
  completeSetup(
    binding: ConnectorProviderBinding,
    sessionUri: string,
    signal: AbortSignal,
  ): Promise<void>;
  inspectAccount(
    binding: ConnectorProviderBinding,
    signal: AbortSignal,
  ): Promise<ConnectorProviderAccount | null>;
  /** Dispatch only; the service verifies account/grants immediately before its durable dispatch claim. */
  execute(
    input: {
      binding: ConnectorProviderBinding;
      actionId: string;
      version: string;
      arguments: { [key: string]: ConnectorJson };
    },
    signal: AbortSignal,
  ): Promise<ConnectorProviderExecution>;
}
