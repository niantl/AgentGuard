import { randomHex } from "@/security/crypto";

/**
 * Razorpay gateway access.
 *
 * AgentGuard is the only component that ever touches this client. Keys live in the
 * server environment and are never placed in a prompt or returned to an agent.
 *
 * When test-mode keys are absent the module falls back to a clearly-labelled
 * simulated gateway so the demo remains fully runnable. The mode is surfaced in
 * the dashboard so a simulated order is never mistaken for a real test-mode order.
 */

export interface RazorpayOrderRequest {
  amount: number; // paisa
  currency: string;
  receipt?: string;
  notes?: Record<string, string>;
  payment_capture?: boolean;
}

export interface RazorpayOrder {
  id: string;
  amount: number | string;
  currency: string;
  status?: string;
  receipt?: string | null;
  [key: string]: unknown;
}

export interface RazorpayLike {
  orders: {
    create(request: RazorpayOrderRequest): Promise<RazorpayOrder>;
  };
}

export type GatewayMode = "RAZORPAY_TEST_KEYS" | "SIMULATED";

export interface GatewayHandle {
  client: RazorpayLike;
  mode: GatewayMode;
  /** How many times `orders.create` has been invoked in this process. */
  callCount(): number;
  description: string;
}

/**
 * In-process stand-in for Razorpay Orders. Behaves like the real API's happy path
 * and supports deliberate failure injection for the gateway-error test.
 */
export class SimulatedRazorpayGateway implements RazorpayLike {
  private calls = 0;
  private failNextWith: Error | null = null;

  readonly orders = {
    create: async (request: RazorpayOrderRequest): Promise<RazorpayOrder> => {
      this.calls += 1;
      // Mimic a network round trip so the engine's await points behave realistically.
      await new Promise((resolve) => setTimeout(resolve, 5));

      if (this.failNextWith) {
        const error = this.failNextWith;
        this.failNextWith = null;
        throw error;
      }

      if (!Number.isInteger(request.amount) || request.amount <= 0) {
        throw new Error("Razorpay: amount must be a positive integer in paisa");
      }

      return {
        id: `order_SIM${randomHex(7)}`,
        amount: request.amount,
        currency: request.currency,
        status: "created",
        receipt: request.receipt ?? null,
        notes: request.notes ?? {},
        simulated: true,
      };
    },
  };

  callCount(): number {
    return this.calls;
  }

  resetCallCount(): void {
    this.calls = 0;
  }

  /** Make the next `orders.create` reject — used by the gateway-failure test. */
  failNextCall(error: Error = new Error("Razorpay gateway unavailable")): void {
    this.failNextWith = error;
  }
}

export function createGateway(): GatewayHandle {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const hasRealKeys =
    !!keyId &&
    !!keySecret &&
    !keyId.includes("xxxxxxxx") &&
    !keySecret.includes("xxxxxxxx");

  if (hasRealKeys) {
    try {
      // Required lazily so the package is only loaded when keys are configured.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Razorpay = require("razorpay");
      const instance = new Razorpay({ key_id: keyId, key_secret: keySecret });
      let calls = 0;
      const wrapped: RazorpayLike = {
        orders: {
          create: async (request) => {
            calls += 1;
            return (await instance.orders.create(request)) as RazorpayOrder;
          },
        },
      };
      return {
        client: wrapped,
        mode: "RAZORPAY_TEST_KEYS",
        callCount: () => calls,
        description: `Razorpay SDK, test-mode key ${keyId.slice(0, 12)}…`,
      };
    } catch (error) {
      // Fall through to the simulated gateway rather than taking the demo down.
      console.warn(
        "[AgentGuard] Razorpay SDK unavailable, falling back to simulated gateway:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const simulated = new SimulatedRazorpayGateway();
  return {
    client: simulated,
    mode: "SIMULATED",
    callCount: () => simulated.callCount(),
    description:
      "Simulated gateway — no RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET configured. " +
      "Order IDs are prefixed order_SIM and are not real Razorpay orders.",
  };
}
