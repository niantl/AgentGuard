import { sha256Hex } from "@/security/crypto";
import type { AuditLogBlock } from "@/types/agentGuard";

/**
 * Merkle tree construction and selective-disclosure proofs over the audit log.
 *
 * Supplements (does not replace) the existing linear hash chain. The hash chain
 * proves *global* integrity — nothing in the whole log was altered. The Merkle
 * tree adds *selective disclosure* — you can hand an auditor proof that one
 * specific transaction is in the ledger and untampered, without exposing every
 * other agent's spend history.
 *
 * ## Known simplification
 *
 * The tree is recomputed on demand rather than maintained incrementally (à la
 * Certificate Transparency, RFC 6962). Fine at hackathon/demo data volumes; a
 * real production version would maintain it incrementally.
 */

export interface InclusionProofStep {
  hash: string;
  side: "left" | "right";
}

export interface InclusionProof {
  leaf: string;
  path: InclusionProofStep[];
  root: string;
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

/**
 * Build a Merkle root from audit blocks.
 *
 * Leaves are each block's `currentHash`, in append order. On an odd count the
 * last leaf is duplicated so every level has an even number of nodes.
 */
export function buildMerkleRoot(blocks: AuditLogBlock[]): string {
  if (blocks.length === 0) return sha256Hex("");

  let level: string[] = blocks.map((block) => block.currentHash);

  while (level.length > 1) {
    const next: string[] = [];
    // Duplicate last leaf if odd
    if (level.length % 2 !== 0) {
      level.push(level[level.length - 1]!);
    }
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256Hex(level[i]! + level[i + 1]!));
    }
    level = next;
  }

  return level[0]!;
}

// ---------------------------------------------------------------------------
// Inclusion proof generation
// ---------------------------------------------------------------------------

/**
 * Build an inclusion proof for a specific entry in the audit log.
 *
 * Returns the leaf hash, the sibling-hash path from that leaf up to the root,
 * and the root itself. An external auditor can verify inclusion with only these
 * three values — no access to the full `blocks` array is needed.
 */
export function getInclusionProof(
  entryId: string,
  blocks: AuditLogBlock[],
): InclusionProof | null {
  const leafIndex = blocks.findIndex((block) => block.entryId === entryId);
  if (leafIndex === -1) return null;

  let level: string[] = blocks.map((block) => block.currentHash);
  const leaf = level[leafIndex]!;
  const path: InclusionProofStep[] = [];
  let currentIndex = leafIndex;

  while (level.length > 1) {
    // Duplicate last leaf if odd
    if (level.length % 2 !== 0) {
      level.push(level[level.length - 1]!);
    }

    // Find sibling
    if (currentIndex % 2 === 0) {
      // Current is left, sibling is right
      path.push({ hash: level[currentIndex + 1]!, side: "right" });
    } else {
      // Current is right, sibling is left
      path.push({ hash: level[currentIndex - 1]!, side: "left" });
    }

    // Move to parent level
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256Hex(level[i]! + level[i + 1]!));
    }
    level = next;
    currentIndex = Math.floor(currentIndex / 2);
  }

  return { leaf, path, root: level[0]! };
}

// ---------------------------------------------------------------------------
// Standalone verifier — the function an external auditor would call
// ---------------------------------------------------------------------------

/**
 * Verify an inclusion proof given only the leaf hash, the sibling-hash path,
 * and the expected root.
 *
 * This function does NOT require access to the full audit log. It recomputes
 * the root from the leaf and the proof path, then compares against the
 * expected root.
 */
export function verifyInclusionProof(
  leaf: string,
  path: InclusionProofStep[],
  root: string,
): boolean {
  let current = leaf;
  for (const step of path) {
    if (step.side === "left") {
      current = sha256Hex(step.hash + current);
    } else {
      current = sha256Hex(current + step.hash);
    }
  }
  return current === root;
}
