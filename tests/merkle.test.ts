import { describe, expect, it } from "vitest";
import { HashChainLogger } from "@/logger/hashChainLogger";
import {
  buildMerkleRoot,
  getInclusionProof,
  verifyInclusionProof,
} from "@/logger/merkleAudit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAuditChain(eventCount: number): HashChainLogger {
  const logger = new HashChainLogger();
  for (let i = 0; i < eventCount; i++) {
    logger.log(`auth_${i % 3}`, `EVENT_${i}`, { index: i, merchant: `m_${i % 5}` });
  }
  return logger;
}

// ===========================================================================
// Merkle tree construction
// ===========================================================================

describe("buildMerkleRoot", () => {
  it("returns a deterministic root for the same blocks", () => {
    const logger = buildAuditChain(10);
    const blocks = logger.getChain();
    const root1 = buildMerkleRoot(blocks);
    const root2 = buildMerkleRoot(blocks);
    expect(root1).toBe(root2);
    expect(root1).toHaveLength(64); // SHA-256 hex
  });

  it("produces a different root when any block changes", () => {
    const logger = buildAuditChain(6);
    const blocks = logger.getChain();
    const root1 = buildMerkleRoot(blocks);

    // Tamper with a block
    const tampered = [...blocks];
    tampered[2] = { ...tampered[2]!, currentHash: "0".repeat(64) };
    const root2 = buildMerkleRoot(tampered);

    expect(root1).not.toBe(root2);
  });

  it("handles a single block", () => {
    const logger = new HashChainLogger();
    const root = buildMerkleRoot(logger.getChain());
    expect(root).toHaveLength(64);
  });

  it("handles an empty array", () => {
    const root = buildMerkleRoot([]);
    expect(root).toHaveLength(64);
  });

  it("handles odd-count blocks (last leaf duplicated)", () => {
    const logger = buildAuditChain(7);
    const root = buildMerkleRoot(logger.getChain());
    expect(root).toHaveLength(64);
  });
});

// ===========================================================================
// Inclusion proofs
// ===========================================================================

describe("getInclusionProof + verifyInclusionProof", () => {
  it("valid proof for an untampered leaf verifies true", () => {
    const logger = buildAuditChain(10);
    const blocks = logger.getChain();
    const proof = getInclusionProof("BLOCK_5", blocks);

    expect(proof).not.toBeNull();
    expect(proof!.leaf).toBe(blocks[5]!.currentHash);
    expect(proof!.root).toBe(buildMerkleRoot(blocks));

    // Verify with ONLY leaf, path, and root — no access to blocks
    const valid = verifyInclusionProof(proof!.leaf, proof!.path, proof!.root);
    expect(valid).toBe(true);
  });

  it("returns null for a nonexistent entry", () => {
    const logger = buildAuditChain(5);
    const proof = getInclusionProof("BLOCK_999", logger.getChain());
    expect(proof).toBeNull();
  });

  it("proof works for the first block (genesis)", () => {
    const logger = buildAuditChain(5);
    const blocks = logger.getChain();
    const proof = getInclusionProof("BLOCK_0", blocks)!;

    expect(verifyInclusionProof(proof.leaf, proof.path, proof.root)).toBe(true);
  });

  it("proof works for the last block", () => {
    const logger = buildAuditChain(8);
    const blocks = logger.getChain();
    const lastEntry = blocks[blocks.length - 1]!.entryId;
    const proof = getInclusionProof(lastEntry, blocks)!;

    expect(verifyInclusionProof(proof.leaf, proof.path, proof.root)).toBe(true);
  });

  it("tampered block invalidates the root; old proof returns false against new root", () => {
    const logger = buildAuditChain(8);
    const blocks = logger.getChain();

    // Get a proof for block 3
    const proof = getInclusionProof("BLOCK_3", blocks)!;
    expect(verifyInclusionProof(proof.leaf, proof.path, proof.root)).toBe(true);

    // Tamper with block 5's currentHash — simulates an attacker who modifies
    // the block content AND recomputes its hash (the strongest attacker).
    // The Merkle root changes because the leaf at index 5 is now different.
    const tampered = blocks.map((b) => ({ ...b }));
    tampered[5] = {
      ...tampered[5]!,
      currentHash: "a".repeat(64), // attacker-chosen hash
    };

    // Recompute the root from the tampered blocks
    const newRoot = buildMerkleRoot(tampered);

    // The root MUST change because a leaf changed
    expect(proof.root).not.toBe(newRoot);

    // The old proof for block 3 still verifies against the OLD root
    // (selective disclosure property)
    expect(verifyInclusionProof(proof.leaf, proof.path, proof.root)).toBe(true);
    // But fails against the new root
    expect(verifyInclusionProof(proof.leaf, proof.path, newRoot)).toBe(false);
  });

  it("verifyInclusionProof works from {leaf, path, root} alone — no blocks reference", () => {
    const logger = buildAuditChain(12);
    const blocks = logger.getChain();
    const proof = getInclusionProof("BLOCK_7", blocks)!;

    // Destructure to prove we only use these three values
    const { leaf, path, root } = proof;

    // The function signature takes only these three arguments
    const valid = verifyInclusionProof(leaf, path, root);
    expect(valid).toBe(true);

    // Confirm it actually fails for wrong inputs
    expect(verifyInclusionProof("wrong_leaf", path, root)).toBe(false);
    expect(verifyInclusionProof(leaf, path, "wrong_root")).toBe(false);
    expect(verifyInclusionProof(leaf, [], root)).toBe(false);
  });

  it("proofs verify for every block in a large-ish chain", () => {
    const logger = buildAuditChain(30);
    const blocks = logger.getChain();
    const root = buildMerkleRoot(blocks);

    for (const block of blocks) {
      const proof = getInclusionProof(block.entryId, blocks)!;
      expect(proof).not.toBeNull();
      expect(proof.root).toBe(root);
      expect(verifyInclusionProof(proof.leaf, proof.path, proof.root)).toBe(true);
    }
  });
});
