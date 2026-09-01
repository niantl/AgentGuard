import type { MerchantCartQuote } from "@/types/agentGuard";

/**
 * Mock merchant cart API.
 *
 * Returns a `MerchantCartQuote` for an itemId with configurable base price, tax and
 * shipping so price slippage can be triggered on demand. An optional latency makes
 * the engine's `await` points behave like a real network call, which is what lets the
 * concurrent-budget-drain test exercise a genuine interleaving.
 *
 * NOTE: for this build the cart API's response is TRUSTED input. AgentGuard does not
 * verify the merchant's authenticity or signature — see README "Explicitly out of
 * scope". What AgentGuard does guarantee is that however hostile the *number* coming
 * back is, it cannot exceed the policy cap.
 */

export interface CatalogEntry {
  itemId: string;
  title: string;
  category: string;
  merchantId: string;
  basePriceInPaisa: number;
  taxInPaisa: number;
  shippingInPaisa: number;
  /** Untrusted, vendor-controlled free text. May contain injection payloads. */
  description: string;
}

export interface MerchantCartApiOptions {
  latencyMs?: number;
  catalog?: CatalogEntry[];
}

export const DEFAULT_CATALOG: CatalogEntry[] = [
  {
    itemId: "item_stationery_bulk",
    title: "A4 Copier Paper — 10 ream carton",
    category: "office_supplies",
    merchantId: "merchant_officedepot_in",
    basePriceInPaisa: 42_000,
    taxInPaisa: 7_560,
    shippingInPaisa: 4_400,
    description: "80 GSM multipurpose copier paper, 500 sheets per ream.",
  },
  {
    itemId: "item_ergo_chair",
    title: "Ergonomic mesh task chair",
    category: "office_supplies",
    merchantId: "merchant_officedepot_in",
    basePriceInPaisa: 320_000,
    taxInPaisa: 57_600,
    shippingInPaisa: 12_000,
    description: "Adjustable lumbar support, 3D armrests, nylon base.",
  },
  {
    itemId: "item_laptop_dock",
    title: "USB-C 13-port docking station",
    category: "electronics",
    merchantId: "merchant_techmart_in",
    basePriceInPaisa: 180_000,
    taxInPaisa: 32_400,
    shippingInPaisa: 0,
    description: "Dual 4K output, 100 W passthrough charging.",
  },
  {
    itemId: "item_overpriced_monitor",
    title: '32" 4K reference monitor',
    category: "electronics",
    merchantId: "merchant_techmart_in",
    basePriceInPaisa: 640_000,
    taxInPaisa: 115_200,
    shippingInPaisa: 8_000,
    description: "Factory-calibrated Delta-E < 1 panel.",
  },
];

export class MockMerchantCartApi {
  private catalog: Map<string, CatalogEntry>;
  private latencyMs: number;
  private overrides = new Map<string, Partial<CatalogEntry>>();
  private fetchCount = 0;

  constructor(options: MerchantCartApiOptions = {}) {
    this.latencyMs = options.latencyMs ?? 4;
    this.catalog = new Map((options.catalog ?? DEFAULT_CATALOG).map((entry) => [entry.itemId, entry]));
  }

  /** Force a specific price shape for an item — the price-slippage lever. */
  setPriceOverride(itemId: string, override: Partial<CatalogEntry>): void {
    this.overrides.set(itemId, override);
  }

  clearOverrides(): void {
    this.overrides.clear();
  }

  getEntry(itemId: string): CatalogEntry | undefined {
    const base = this.catalog.get(itemId);
    if (!base) return undefined;
    return { ...base, ...(this.overrides.get(itemId) ?? {}) };
  }

  listCatalog(): CatalogEntry[] {
    return Array.from(this.catalog.keys())
      .map((itemId) => this.getEntry(itemId)!)
      .filter(Boolean);
  }

  getFetchCount(): number {
    return this.fetchCount;
  }

  /** The `fetchCartQuote` callback handed to `GuardrailEngine.processTransaction`. */
  readonly fetchCartQuote = async (itemId: string): Promise<MerchantCartQuote> => {
    this.fetchCount += 1;
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    const entry = this.getEntry(itemId);
    if (!entry) {
      throw new Error(`Mock merchant cart API: unknown itemId "${itemId}"`);
    }

    const basePriceInPaisa = entry.basePriceInPaisa;
    const taxInPaisa = entry.taxInPaisa;
    const shippingInPaisa = entry.shippingInPaisa;

    return {
      itemId,
      basePriceInPaisa,
      taxInPaisa,
      shippingInPaisa,
      totalQuoteInPaisa: basePriceInPaisa + taxInPaisa + shippingInPaisa,
    };
  };
}

/** Fixed-total quote source, for tests that care only about the number. */
export function fixedQuote(totalInPaisa: number, itemId = "item_fixed"): MerchantCartQuote {
  const basePriceInPaisa = Math.round(totalInPaisa * 0.85);
  const taxInPaisa = Math.round(totalInPaisa * 0.13);
  const shippingInPaisa = totalInPaisa - basePriceInPaisa - taxInPaisa;
  return { itemId, basePriceInPaisa, taxInPaisa, shippingInPaisa, totalQuoteInPaisa: totalInPaisa };
}

export function fixedQuoteFetcher(
  totalInPaisa: number,
  options: { latencyMs?: number } = {},
): (itemId: string) => Promise<MerchantCartQuote> {
  return async (itemId: string) => {
    if (options.latencyMs && options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    }
    return fixedQuote(totalInPaisa, itemId);
  };
}
