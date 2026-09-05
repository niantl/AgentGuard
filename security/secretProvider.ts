import crypto from "node:crypto";

/**
 * Pluggable secret provider for AgentGuard.
 *
 * The engine takes a `SecretProvider` at construction instead of reading
 * `process.env` directly. Default remains `EnvSecretProvider` (no behavior
 * change without explicit opt-in).
 *
 * ## Fail-closed rule
 *
 * If `KmsSecretProvider` is configured but KMS is unreachable at boot, the
 * process must fail to start with a clear error — never silently fall back to
 * an env-var secret.
 */

export interface SecretProvider {
  getHmacSecret(): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Environment variable provider (current default behavior)
// ---------------------------------------------------------------------------

import { getServerSecret } from "@/security/crypto";

export class EnvSecretProvider implements SecretProvider {
  async getHmacSecret(): Promise<Buffer> {
    return Buffer.from(getServerSecret(), "utf8");
  }
}

// ---------------------------------------------------------------------------
// AWS KMS provider (explicit opt-in)
// ---------------------------------------------------------------------------

export interface KmsConfig {
  /** The KMS key ARN or alias to use for generating data keys. */
  keyId: string;
  /** AWS region, e.g. "ap-south-1". */
  region: string;
  /** Connection timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Retrieves the HMAC secret from AWS KMS.
 *
 * If KMS is unreachable at boot, the process MUST fail to start. There is no
 * silent fallback to `EnvSecretProvider` — that would silently downgrade the
 * security posture without any operator knowing.
 */
export class KmsSecretProvider implements SecretProvider {
  private readonly config: KmsConfig;
  private cachedSecret: Buffer | null = null;

  constructor(config: KmsConfig) {
    this.config = config;
  }

  async getHmacSecret(): Promise<Buffer> {
    if (this.cachedSecret) return this.cachedSecret;

    const timeout = this.config.timeoutMs ?? 5_000;

    try {
      // Attempt to retrieve a data key from KMS.
      // In a real implementation this would use the AWS SDK:
      //   const kms = new KMSClient({ region: this.config.region });
      //   const response = await kms.send(new GenerateDataKeyCommand({ ... }));
      //
      // For now we simulate the call structure so the fail-closed behavior
      // and the test harness work correctly.
      const result = await Promise.race([
        this.fetchFromKms(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("KMS connection timed out")), timeout),
        ),
      ]);

      this.cachedSecret = result;
      return result;
    } catch (error) {
      // Fail closed — never silently construct an EnvSecretProvider.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[AgentGuard] KMS secret provider failed: ${message}. ` +
          `The process will NOT start. Do not silently fall back to environment variables. ` +
          `Fix the KMS configuration or explicitly switch to EnvSecretProvider.`,
      );
    }
  }

  /**
   * Actual KMS call. Override in tests to simulate success or failure.
   * In production, this would use the AWS SDK.
   */
  protected async fetchFromKms(): Promise<Buffer> {
    // Placeholder: a real implementation would call AWS KMS here.
    // This exists so KmsSecretProvider can be subclassed in tests with
    // a controlled mock.
    throw new Error(
      `KMS key ${this.config.keyId} in region ${this.config.region}: ` +
        `AWS SDK not configured. Set up @aws-sdk/client-kms or use EnvSecretProvider.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SecretProvider from environment configuration.
 *
 * - If `AGENTGUARD_KMS_KEY_ID` is set, creates a `KmsSecretProvider`.
 * - Otherwise, creates an `EnvSecretProvider` (default, backward compatible).
 */
export function createSecretProvider(): SecretProvider {
  const kmsKeyId = process.env.AGENTGUARD_KMS_KEY_ID;
  const kmsRegion = process.env.AGENTGUARD_KMS_REGION ?? "ap-south-1";

  if (kmsKeyId) {
    return new KmsSecretProvider({ keyId: kmsKeyId, region: kmsRegion });
  }

  return new EnvSecretProvider();
}
