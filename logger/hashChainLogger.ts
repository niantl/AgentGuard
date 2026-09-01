import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "@/security/crypto";
import type { AuditLogBlock } from "@/types/agentGuard";

/**
 * Append-only, tamper-evident audit log.
 *
 * Every block's hash covers its own contents *and* the previous block's hash, so
 * altering any historical field invalidates that block and every block after it.
 * This does not prevent tampering — it makes tampering detectable.
 */

const GENESIS_PREVIOUS_HASH = "0".repeat(64);

export interface ChainVerificationResult {
  valid: boolean;
  blockCount: number;
  /** Index of the first block that failed verification, or null when the chain is intact. */
  brokenAtIndex: number | null;
  brokenAtEntryId: string | null;
  reason: string | null;
}

export class HashChainLogger {
  private chain: AuditLogBlock[] = [];
  private readonly persistPath: string | null;
  private readonly clock: () => Date;

  constructor(options: { persistPath?: string | null; clock?: () => Date } = {}) {
    this.persistPath = options.persistPath ?? null;
    this.clock = options.clock ?? (() => new Date());

    const loaded = this.load();
    if (!loaded) {
      this.chain = [this.buildGenesisBlock()];
      this.persist();
    }
  }

  // -------------------------------------------------------------------------
  // Hashing
  // -------------------------------------------------------------------------

  /**
   * hash = SHA256(entryId + timestamp + authorizationId + event +
   *               JSON.stringify(details) + previousBlock.currentHash)
   */
  private static computeBlockHash(
    block: Omit<AuditLogBlock, "currentHash">,
  ): string {
    return sha256Hex(
      block.entryId +
        block.timestamp +
        block.authorizationId +
        block.event +
        JSON.stringify(block.details) +
        block.previousHash,
    );
  }

  private buildGenesisBlock(): AuditLogBlock {
    const skeleton: Omit<AuditLogBlock, "currentHash"> = {
      entryId: "BLOCK_0",
      timestamp: this.clock().toISOString(),
      authorizationId: "GENESIS",
      event: "AUDIT_CHAIN_INITIALIZED",
      details: { note: "AgentGuard hash-chain genesis block" },
      previousHash: GENESIS_PREVIOUS_HASH,
    };
    return { ...skeleton, currentHash: HashChainLogger.computeBlockHash(skeleton) };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  log(
    authorizationId: string,
    event: string,
    details: Record<string, any> = {},
  ): AuditLogBlock {
    const previous = this.chain[this.chain.length - 1];
    if (!previous) {
      // Cannot happen: the constructor always seeds a genesis block.
      throw new Error("AgentGuard audit chain is empty — genesis block missing");
    }

    const skeleton: Omit<AuditLogBlock, "currentHash"> = {
      entryId: `BLOCK_${this.chain.length}`,
      timestamp: this.clock().toISOString(),
      authorizationId,
      event,
      details,
      previousHash: previous.currentHash,
    };

    const block: AuditLogBlock = {
      ...skeleton,
      currentHash: HashChainLogger.computeBlockHash(skeleton),
    };

    this.chain.push(block);
    this.persist();
    return block;
  }

  /** True when every block's link and every block's own hash recompute correctly. */
  verifyChainIntegrity(): boolean {
    return this.verifyChainIntegrityDetailed().valid;
  }

  /** Same check as `verifyChainIntegrity`, with the location + cause of any break. */
  verifyChainIntegrityDetailed(): ChainVerificationResult {
    const base = {
      blockCount: this.chain.length,
      brokenAtIndex: null as number | null,
      brokenAtEntryId: null as string | null,
    };

    if (this.chain.length === 0) {
      return { ...base, valid: false, reason: "Chain is empty (no genesis block)" };
    }

    for (let index = 0; index < this.chain.length; index += 1) {
      const block = this.chain[index]!;

      const expectedEntryId = `BLOCK_${index}`;
      if (block.entryId !== expectedEntryId) {
        return {
          ...base,
          valid: false,
          brokenAtIndex: index,
          brokenAtEntryId: block.entryId,
          reason: `Block at position ${index} has entryId "${block.entryId}", expected "${expectedEntryId}"`,
        };
      }

      // Link check.
      const expectedPreviousHash =
        index === 0 ? GENESIS_PREVIOUS_HASH : this.chain[index - 1]!.currentHash;
      if (block.previousHash !== expectedPreviousHash) {
        return {
          ...base,
          valid: false,
          brokenAtIndex: index,
          brokenAtEntryId: block.entryId,
          reason: `${block.entryId} previousHash does not match the preceding block's currentHash`,
        };
      }

      // Content check — recompute this block's own hash from its fields.
      const recomputed = HashChainLogger.computeBlockHash({
        entryId: block.entryId,
        timestamp: block.timestamp,
        authorizationId: block.authorizationId,
        event: block.event,
        details: block.details,
        previousHash: block.previousHash,
      });
      if (recomputed !== block.currentHash) {
        return {
          ...base,
          valid: false,
          brokenAtIndex: index,
          brokenAtEntryId: block.entryId,
          reason: `${block.entryId} contents were modified — recomputed hash does not match stored currentHash`,
        };
      }
    }

    return { ...base, valid: true, reason: null };
  }

  getChain(): AuditLogBlock[] {
    return this.chain;
  }

  getBlockCount(): number {
    return this.chain.length;
  }

  // -------------------------------------------------------------------------
  // Demo-only tamper hooks (used by the dashboard's integrity demonstration)
  // -------------------------------------------------------------------------

  /**
   * DEMO ONLY. Mutates one historical block's `details` in place *without*
   * recomputing its hash, which is exactly what an attacker editing the log file
   * would produce. Returns a restore handle.
   */
  __tamperBlockForDemo(index: number, patch: Record<string, any>): { restore: () => void } | null {
    const block = this.chain[index];
    if (!block) return null;
    const original = block.details;
    block.details = { ...original, ...patch };
    this.persist();
    return {
      restore: () => {
        block.details = original;
        this.persist();
      },
    };
  }

  /** DEMO ONLY. Replaces the chain wholesale (used to restore after a tamper demo). */
  __replaceChainForDemo(chain: AuditLogBlock[]): void {
    this.chain = chain;
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): boolean {
    if (!this.persistPath) return false;
    try {
      if (!fs.existsSync(this.persistPath)) return false;
      const raw = fs.readFileSync(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as { chain?: AuditLogBlock[] };
      if (!Array.isArray(parsed.chain) || parsed.chain.length === 0) return false;
      this.chain = parsed.chain;
      return true;
    } catch {
      // Corrupt audit file: start a fresh chain rather than crashing the process.
      // The break is visible because the old chain is gone, not silently rewritten.
      return false;
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    const dir = path.dirname(this.persistPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Synchronous on purpose — the audit record must hit disk before the caller
    // proceeds to the next state mutation.
    fs.writeFileSync(
      this.persistPath,
      JSON.stringify({ version: 1, chain: this.chain }, null, 2),
      "utf8",
    );
  }
}
