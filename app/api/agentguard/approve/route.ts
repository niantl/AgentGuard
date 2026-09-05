import { NextResponse } from "next/server";
import {
  approveAndSettle,
  getDashboardState,
  resubmitWithApproval,
  submitApproval,
} from "@/runtime/agentGuardRuntime";
import type { ApprovalDecision } from "@/api/approve";
import { verifyAdminToken } from "@/security/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /agentguard/approve
 *
 * Body: { authorizationId, idempotencyKey, approverId, decision: "approve" | "deny" }
 *
 * On "approve" the response carries a short-lived, single-use HMAC token bound to the
 * exact escalated proposal and the exact quoted amount. The caller then resubmits the
 * original IntentProposal with that token attached — the token alone moves no money.
 *
 * Passing `settle: true` performs that resubmission server-side in the same request,
 * which is what the dashboard's one-click Approve button uses. The engine path is
 * identical either way.
 */
export async function POST(request: Request) {
  if (!verifyAdminToken(request)) {
    return NextResponse.json(
      { ok: false, code: "ERR_UNAUTHORIZED", message: "Unauthorized: valid x-agentguard-admin-token header required" },
      { status: 401 },
    );
  }

  let body: {
    authorizationId?: unknown;
    idempotencyKey?: unknown;
    approverId?: unknown;
    decision?: unknown;
    settle?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "ERR_MALFORMED_BODY", message: "Body must be JSON" },
      { status: 400 },
    );
  }

  const authorizationId = typeof body.authorizationId === "string" ? body.authorizationId : undefined;
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
  const approverId = typeof body.approverId === "string" ? body.approverId : undefined;
  const decision = body.decision as ApprovalDecision | undefined;

  // One-shot approve-and-settle.
  if (decision === "approve" && body.settle === true) {
    if (!authorizationId || !idempotencyKey || !approverId) {
      return NextResponse.json(
        {
          ok: false,
          code: "ERR_MISSING_FIELD",
          message: "authorizationId, idempotencyKey and approverId are all required",
        },
        { status: 400 },
      );
    }
    const settled = await approveAndSettle({ authorizationId, idempotencyKey, approverId });
    const status = settled.approval.ok ? 200 : settled.approval.status;
    return NextResponse.json({ ...settled, state: getDashboardState() }, { status });
  }

  const response = await submitApproval({ authorizationId, idempotencyKey, approverId, decision });
  if (!response.ok) {
    return NextResponse.json({ ...response, state: getDashboardState() }, { status: response.status });
  }

  return NextResponse.json({ ...response, state: getDashboardState() });
}

/**
 * PUT — resubmit an escalated proposal with a token obtained from POST.
 *
 * Kept separate so the two-step flow in the spec (issue token → resubmit proposal) can
 * be exercised directly, e.g. with curl.
 */
export async function PUT(request: Request) {
  if (!verifyAdminToken(request)) {
    return NextResponse.json(
      { ok: false, code: "ERR_UNAUTHORIZED", message: "Unauthorized: valid x-agentguard-admin-token header required" },
      { status: 401 },
    );
  }

  let body: { idempotencyKey?: unknown; encodedToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Body must be JSON" }, { status: 400 });
  }

  if (typeof body.idempotencyKey !== "string" || typeof body.encodedToken !== "string") {
    return NextResponse.json(
      { ok: false, message: "idempotencyKey and encodedToken are required" },
      { status: 400 },
    );
  }

  const settled = await resubmitWithApproval(body.idempotencyKey, body.encodedToken);
  return NextResponse.json(
    { ...settled, state: getDashboardState() },
    { status: settled.ok ? 200 : 409 },
  );
}
