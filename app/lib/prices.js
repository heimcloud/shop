/** Display CHF + Stripe Test price IDs (defaults; override via env). Price IDs are not secrets. */

export const STRIPE_PRICES = {
  kit: process.env.STRIPE_PRICE_KIT || "price_1UFvgv1oIIxcEEBR67p9pqaf",
  public_ip: process.env.STRIPE_PRICE_PUBLIC_IP || "price_1UFviO1oIIxcEEBRE6vE1O4L",
  airvpn: process.env.STRIPE_PRICE_AIRVPN || "price_1UFvjR1oIIxcEEBR8aHsaXaA",
  hermes: process.env.STRIPE_PRICE_HERMES || "price_1UFvke1oIIxcEEBR2ZyLrPyV",
  backups: process.env.STRIPE_PRICE_BACKUPS || "price_1UFvmL1oIIxcEEBRAVZNH5s7",
};

/** Hardware — one-time. Base maps to STRIPE_PRICE_KIT (CHF 499). */
export const KIT = {
  base: {
    id: "zimablade-base",
    name: "ZimaBlade kit",
    chf: 499,
    billing: "one_time",
    stripePrice: STRIPE_PRICES.kit,
  },
  rack: {
    none: { id: "rack-none", name: "No rack", chf: 0, billing: "one_time" },
    mini: { id: "rack-mini", name: "Mini rack shelf", chf: 79, billing: "one_time" },
    full: { id: "rack-full", name: "1U rack kit", chf: 149, billing: "one_time" },
  },
  storage: {
    none: { id: "stor-none", name: "No drive", chf: 0, billing: "one_time" },
    ssd1: { id: "ssd-1tb", name: "1 TB NVMe SSD", chf: 89, billing: "one_time" },
    ssd2: { id: "ssd-2tb", name: "2 TB NVMe SSD", chf: 149, billing: "one_time" },
    hdd4: { id: "hdd-4tb", name: "4 TB HDD", chf: 119, billing: "one_time" },
    hdd8: { id: "hdd-8tb", name: "8 TB HDD", chf: 189, billing: "one_time" },
  },
  shippingCh: { id: "ship-ch", name: "CH shipping", chf: 15, billing: "one_time" },
};

/** Managed services — monthly subscriptions. */
export const SERVICES = {
  public_ip: {
    id: "public_ip",
    name: "Public IP",
    desc: "Static or routed public IPv4 for your Neo.",
    chf: 12,
    billing: "month",
    stripePrice: STRIPE_PRICES.public_ip,
  },
  airvpn: {
    id: "airvpn",
    name: "AirVPN",
    desc: "VPN egress / privacy route helpers.",
    chf: 9,
    billing: "month",
    stripePrice: STRIPE_PRICES.airvpn,
  },
  hermes: {
    id: "hermes",
    name: "Hermes AI tokens",
    desc: "Monthly token allowance for Hermes messaging.",
    chf: 19,
    billing: "month",
    stripePrice: STRIPE_PRICES.hermes,
  },
  backups: {
    id: "backups",
    name: "Backups",
    desc: "Offsite backup slots for Neo volumes.",
    chf: 8,
    billing: "month",
    stripePrice: STRIPE_PRICES.backups,
  },
};

export function computeKitTotal({ rack = "none", storage = "none", includeShipping = true } = {}) {
  const rackOpt = KIT.rack[rack] || KIT.rack.none;
  const storOpt = KIT.storage[storage] || KIT.storage.none;
  const ship = includeShipping ? KIT.shippingCh.chf : 0;
  const total = KIT.base.chf + rackOpt.chf + storOpt.chf + ship;
  return {
    lines: [
      { ...KIT.base },
      { ...rackOpt },
      { ...storOpt },
      ...(includeShipping ? [{ ...KIT.shippingCh }] : []),
    ].filter((l) => l.chf > 0 || l.id === KIT.base.id),
    totalChf: total,
  };
}

/** Parse service ids from query/body (comma-separated or repeated). */
export function parseServiceIds(raw) {
  const list = Array.isArray(raw)
    ? raw.flatMap((v) => String(v).split(","))
    : String(raw || "").split(",");
  return [...new Set(list.map((s) => s.trim()).filter((id) => SERVICES[id]))];
}

export function selectedServices(ids) {
  return parseServiceIds(ids).map((id) => SERVICES[id]);
}

/**
 * Build Stripe Checkout mode + line_items.
 * - Hardware only → mode: payment (kit Price ID + price_data for rack/storage/shipping)
 * - Any services → mode: subscription (recurring Price IDs + one-time kit Price ID if hardware)
 *   Add-ons without Stripe Prices are kept in metadata only when in subscription mode
 *   (Checkout subscription sessions accept one-time Price IDs alongside recurring).
 */
export function buildStripeCheckout({ includeKit = true, rack = "none", storage = "none", serviceIds = [] } = {}) {
  const services = selectedServices(serviceIds);
  const hasServices = services.length > 0;
  const mode = hasServices ? "subscription" : "payment";
  const line_items = [];

  const rackOpt = KIT.rack[rack] || KIT.rack.none;
  const storOpt = KIT.storage[storage] || KIT.storage.none;
  const addOns = [rackOpt, storOpt, KIT.shippingCh].filter((o) => o.chf > 0);

  if (includeKit) {
    line_items.push({ price: KIT.base.stripePrice, quantity: 1 });
    if (mode === "payment") {
      for (const opt of addOns) {
        line_items.push({
          quantity: 1,
          price_data: {
            currency: "chf",
            unit_amount: Math.round(opt.chf * 100),
            product_data: { name: opt.name },
          },
        });
      }
    }
  }

  for (const svc of services) {
    line_items.push({ price: svc.stripePrice, quantity: 1 });
  }

  const kitPart = includeKit ? computeKitTotal({ rack, storage, includeShipping: true }) : { lines: [], totalChf: 0 };
  const servicesMonthly = services.reduce((s, x) => s + x.chf, 0);

  return {
    mode,
    line_items,
    kitLines: kitPart.lines,
    serviceLines: services,
    kitTotalChf: kitPart.totalChf,
    servicesMonthlyChf: servicesMonthly,
    hasHardware: includeKit,
    hasServices,
    /** Add-ons charged via Stripe only in payment mode; always listed for ops metadata */
    addOnsMeta: includeKit ? addOns.map((a) => `${a.id}:${a.chf}`).join(",") : "",
  };
}
