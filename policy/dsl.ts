import YAML from "yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  createAuthorizationPolicy,
  PolicyValidationError,
  validateEscalationReachability,
} from "@/policy/policyFactory";
import type { AuthorizationPolicy } from "@/types/agentGuard";

/**
 * Policy DSL — structured YAML, not free-text/NLP, not compiled by a model.
 *
 * `compilePolicyDsl(yamlSource)` parses YAML, validates against a JSON Schema,
 * runs the shared `validateEscalationReachability` check (the same function used
 * by `createAuthorizationPolicy`), and HMAC-signs the result through the existing
 * signing path.
 *
 * ## Non-negotiable rules
 *
 * 1. No LLM/model call anywhere in this module's call graph.
 * 2. On any schema violation or failed validation, throw — fail closed, no
 *    partial policy.
 * 3. The `requiresHumanApprovalAbovePaisa <= maxAmountInPaisa` check is
 *    delegated to the shared function in `policyFactory.ts`, never duplicated.
 */

// ---------------------------------------------------------------------------
// JSON Schema for the DSL YAML
// ---------------------------------------------------------------------------

const POLICY_DSL_SCHEMA = {
  type: "object",
  required: ["authorizationId", "userId", "purpose", "budget", "categories", "merchants"],
  additionalProperties: false,
  properties: {
    authorizationId: { type: "string", minLength: 1 },
    userId: { type: "string", minLength: 1 },
    purpose: { type: "string", minLength: 1 },
    budget: {
      type: "object",
      required: ["maxAmountInPaisa", "currency", "expiresAt"],
      additionalProperties: false,
      properties: {
        maxAmountInPaisa: { type: "integer", minimum: 1 },
        currency: { type: "string", enum: ["INR"] },
        expiresAt: { type: "string", format: "date-time" },
      },
    },
    categories: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    merchants: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    escalation: {
      type: "object",
      additionalProperties: false,
      properties: {
        requiresHumanApprovalAbovePaisa: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

interface PolicyDslInput {
  authorizationId: string;
  userId: string;
  purpose: string;
  budget: {
    maxAmountInPaisa: number;
    currency: "INR";
    expiresAt: string;
  };
  categories: string[];
  merchants: string[];
  escalation?: {
    requiresHumanApprovalAbovePaisa?: number;
  };
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile<PolicyDslInput>(POLICY_DSL_SCHEMA);

/**
 * Compile a YAML policy source into a signed `AuthorizationPolicy`.
 *
 * 1. Parse the YAML.
 * 2. Validate against the JSON Schema — reject on any violation.
 * 3. Call the shared `validateEscalationReachability` function.
 * 4. Delegate to `createAuthorizationPolicy` for signing.
 */
export function compilePolicyDsl(yamlSource: string): AuthorizationPolicy {
  // 1. Parse YAML
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PolicyValidationError(
      "ERR_DSL_YAML_PARSE",
      `Failed to parse YAML: ${message}`,
    );
  }

  // 2. Validate against JSON Schema
  if (!validate(parsed)) {
    const errors = validate.errors ?? [];
    const details = errors
      .map((e) => `${e.instancePath || "/"}: ${e.message}`)
      .join("; ");
    throw new PolicyValidationError(
      "ERR_DSL_SCHEMA_VIOLATION",
      `Policy YAML failed schema validation: ${details}`,
    );
  }

  const input = parsed;
  const maxAmountInPaisa = input.budget.maxAmountInPaisa;
  const requiresHumanApprovalAbovePaisa =
    input.escalation?.requiresHumanApprovalAbovePaisa ?? maxAmountInPaisa;

  // 3. Call the SHARED escalation-reachability check — same function as
  //    createAuthorizationPolicy uses. Do not duplicate this check.
  validateEscalationReachability(requiresHumanApprovalAbovePaisa, maxAmountInPaisa);

  // 4. Delegate to the existing policy creation + signing path
  return createAuthorizationPolicy({
    authorizationId: input.authorizationId,
    userId: input.userId,
    purpose: input.purpose,
    maxAmountInPaisa,
    allowedCategories: input.categories,
    allowedMerchants: input.merchants,
    expiresAt: input.budget.expiresAt,
    requiresHumanApprovalAbovePaisa,
    currency: input.budget.currency,
  });
}
