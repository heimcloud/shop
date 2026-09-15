/** Example CHF prices for MVP — not final retail. Marked as examples in README. */
export const KIT = {
  base: { id: "zimablade-base", name: "ZimaBlade base", chf: 499 },
  rack: {
    none: { id: "rack-none", name: "No rack", chf: 0 },
    mini: { id: "rack-mini", name: "Mini rack shelf", chf: 79 },
    full: { id: "rack-full", name: "1U rack kit", chf: 149 },
  },
  storage: {
    none: { id: "stor-none", name: "No drive", chf: 0 },
    ssd1: { id: "ssd-1tb", name: "1 TB NVMe SSD", chf: 89 },
    ssd2: { id: "ssd-2tb", name: "2 TB NVMe SSD", chf: 149 },
    hdd4: { id: "hdd-4tb", name: "4 TB HDD", chf: 119 },
    hdd8: { id: "hdd-8tb", name: "8 TB HDD", chf: 189 },
  },
  shippingCh: { id: "ship-ch", name: "CH shipping", chf: 15 },
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
