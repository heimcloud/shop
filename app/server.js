import express from "express";
import Stripe from "stripe";
import { layout, money } from "./lib/layout.js";
import {
  KIT,
  SERVICES,
  computeKitTotal,
  parseServiceIds,
  buildStripeCheckout,
} from "./lib/prices.js";

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const paymentsConfigured = Boolean(STRIPE_SECRET);

const stripe = paymentsConfigured ? new Stripe(STRIPE_SECRET) : null;
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(new URL("./public", import.meta.url).pathname));

function paymentsBanner() {
  if (paymentsConfigured) return "";
  return `<div class="alert warn"><strong>Payments not configured.</strong> Set <code>STRIPE_SECRET_KEY</code> (and related keys) to enable Stripe Checkout. You can still browse and fill the order form.</div>`;
}

function servicesQuery(ids) {
  const list = parseServiceIds(ids);
  return list.length ? `&services=${encodeURIComponent(list.join(","))}` : "";
}

app.get("/", (_req, res) => {
  res.type("html").send(
    layout({
      title: "Shop",
      body: `
      <section class="hero">
        <p class="muted">Swiss-market · Neo homeserver kits</p>
        <h1>Heimcloud Shop</h1>
        <p class="lead">ZimaBlade + NAS kits for Switzerland. Configure storage, pay in CHF, we fulfill at month-end.</p>
        <div class="banner">📦 Orders ship in a <strong>month-end batch</strong> — clear lead times, fewer partial shipments.</div>
        <p>
          <a class="btn" href="/kit">Configure ZimaBlade kit</a>
          <a class="btn secondary" href="/mini-pc">Mini-PC interest</a>
        </p>
      </section>
      <section class="grid grid-2">
        <div class="card">
          <h2>NAS kit</h2>
          <p class="muted">ZimaBlade base + optional rack &amp; drives. One-time purchase.</p>
          <p><span class="price">${money(KIT.base.chf)}</span> <span class="muted">one-time</span></p>
          <a href="/kit">Build kit →</a>
        </div>
        <div class="card">
          <h2>Managed services</h2>
          <p class="muted">Public IP, AirVPN, Hermes tokens, backups — monthly subscriptions.</p>
          <a href="/services">See services →</a>
        </div>
      </section>`,
    }),
  );
});

app.get("/kit", (req, res) => {
  const rack = req.query.rack || "none";
  const storage = req.query.storage || "none";
  const services = parseServiceIds(req.query.services);
  const { lines, totalChf } = computeKitTotal({ rack, storage, includeShipping: true });
  const svcQs = servicesQuery(services);

  const rackOptions = Object.entries(KIT.rack)
    .map(
      ([k, v]) =>
        `<option value="${k}" ${k === rack ? "selected" : ""}>${v.name} (+${money(v.chf)})</option>`,
    )
    .join("");
  const storOptions = Object.entries(KIT.storage)
    .map(
      ([k, v]) =>
        `<option value="${k}" ${k === storage ? "selected" : ""}>${v.name} (+${money(v.chf)})</option>`,
    )
    .join("");

  res.type("html").send(
    layout({
      title: "Kit configurator",
      body: `
      <h1>ZimaBlade kit</h1>
      <p class="muted">Hardware is <strong>one-time</strong>. Base kit ${money(KIT.base.chf)}.</p>
      <div class="banner">Month-end batch fulfillment · CH shipping ${money(KIT.shippingCh.chf)} one-time</div>
      <form class="card" method="get" action="/kit" id="cfg">
        ${services.length ? `<input type="hidden" name="services" value="${escapeHtml(services.join(","))}" />` : ""}
        <label>Rack</label>
        <select name="rack" onchange="this.form.submit()">${rackOptions}</select>
        <label>Storage</label>
        <select name="storage" onchange="this.form.submit()">${storOptions}</select>
      </form>
      <div class="card">
        <h2>Summary <span class="muted">(one-time)</span></h2>
        <ul class="clean">
          ${lines.map((l) => `<li><span>${l.name}</span><span class="price">${money(l.chf)}</span></li>`).join("")}
          <li><strong>Hardware total</strong><strong class="price">${money(totalChf)}</strong></li>
        </ul>
        <form method="get" action="/order">
          <input type="hidden" name="rack" value="${rack}" />
          <input type="hidden" name="storage" value="${storage}" />
          <input type="hidden" name="kit" value="1" />
          ${services.length ? `<input type="hidden" name="services" value="${escapeHtml(services.join(","))}" />` : ""}
          <button class="btn" type="submit">Continue to order</button>
          <a class="btn secondary" href="/services?kit=1&rack=${encodeURIComponent(rack)}&storage=${encodeURIComponent(storage)}${svcQs}">Add services</a>
        </form>
      </div>`,
    }),
  );
});

app.get("/mini-pc", (_req, res) => {
  res.type("html").send(
    layout({
      title: "Mini-PC",
      body: `
      <h1>Mini-PC — coming soon</h1>
      <p class="lead muted">Compact Neo-ready mini PCs for the Swiss market. Not orderable yet.</p>
      <div class="card">
        <h2>Interest list</h2>
        <p class="muted">Leave your email and we will notify you when SKUs open. Or use mailto.</p>
        <form method="post" action="/mini-pc/interest">
          <label>Email</label>
          <input type="email" name="email" required placeholder="you@example.ch" />
          <label>Note (optional)</label>
          <textarea name="note" rows="3" placeholder="Use case, preferred size…"></textarea>
          <p style="margin-top:1rem"><button class="btn" type="submit">Notify me</button>
          <a class="btn secondary" href="mailto:shop@heimcloud.ch?subject=Mini-PC%20interest">mailto</a></p>
        </form>
      </div>`,
    }),
  );
});

app.post("/mini-pc/interest", (req, res) => {
  const email = String(req.body.email || "").trim();
  console.log("[interest]", { email, note: req.body.note || "" });
  res.type("html").send(
    layout({
      title: "Thanks",
      body: `
      <div class="alert ok">Thanks — we recorded interest for <strong>${escapeHtml(email)}</strong> (local stub).</div>
      <p><a href="/">Back home</a></p>`,
    }),
  );
});

app.get("/services", (req, res) => {
  const rack = req.query.rack || "none";
  const storage = req.query.storage || "none";
  const includeKit = req.query.kit === "1" || req.query.kit === "true";
  const selected = new Set(parseServiceIds(req.query.services));

  const cards = Object.values(SERVICES)
    .map((s) => {
      const checked = selected.has(s.id) ? "checked" : "";
      return `<label class="card" style="display:block;cursor:pointer">
        <input type="checkbox" name="services" value="${s.id}" ${checked} />
        <strong>${s.name}</strong>
        <span class="price" style="float:right">${money(s.chf)}/mo</span>
        <p class="muted">${s.desc}</p>
      </label>`;
    })
    .join("");

  res.type("html").send(
    layout({
      title: "Services",
      body: `
      <h1>Managed services</h1>
      <p class="muted">All services are <strong>monthly subscriptions</strong> (billed in CHF).</p>
      <form class="card" method="get" action="/order">
        ${includeKit ? `<input type="hidden" name="kit" value="1" />
        <input type="hidden" name="rack" value="${escapeHtml(rack)}" />
        <input type="hidden" name="storage" value="${escapeHtml(storage)}" />` : ""}
        <div class="grid grid-2">${cards}</div>
        <p style="margin-top:1.25rem">
          <button class="btn" type="submit">Continue to order</button>
          <a class="btn secondary" href="/kit">Configure kit</a>
        </p>
      </form>`,
    }),
  );
});

app.get("/order", (req, res) => {
  const rack = req.query.rack || "none";
  const storage = req.query.storage || "none";
  const kitParam = req.query.kit;
  const mergedServices = parseServiceIds(req.query.services);

  let withKit;
  if (kitParam === "0" || kitParam === "false") {
    withKit = false;
  } else if (kitParam === "1" || kitParam === "true") {
    withKit = true;
  } else if (req.query.rack != null || req.query.storage != null) {
    withKit = true;
  } else if (mergedServices.length) {
    withKit = false;
  } else {
    withKit = true;
  }

  const built = buildStripeCheckout({
    includeKit: withKit,
    rack,
    storage,
    serviceIds: mergedServices,
  });

  if (!built.hasHardware && !built.hasServices) {
    return res.type("html").send(
      layout({
        title: "Order",
        body: `
        <h1>Order</h1>
        <p class="muted">Nothing selected yet.</p>
        <p><a class="btn" href="/kit">Configure kit</a> <a class="btn secondary" href="/services">Add services</a></p>`,
      }),
    );
  }

  const kitList = built.kitLines
    .map((l) => `<li><span>${l.name} <span class="muted">one-time</span></span><span class="price">${money(l.chf)}</span></li>`)
    .join("");
  const svcList = built.serviceLines
    .map((l) => `<li><span>${l.name} <span class="muted">/mo</span></span><span class="price">${money(l.chf)}/mo</span></li>`)
    .join("");

  const modeHint = built.hasServices
    ? `<p class="muted">Checkout mode: <strong>subscription</strong>${built.hasHardware ? " (includes one-time kit)" : ""}.</p>`
    : `<p class="muted">Checkout mode: <strong>payment</strong> (one-time hardware).</p>`;

  res.type("html").send(
    layout({
      title: "Order",
      body: `
      <h1>Order summary</h1>
      ${paymentsBanner()}
      <div class="banner">Hardware ships in the next <strong>month-end batch</strong>. Services bill monthly.</div>
      <div class="card">
        <ul class="clean">
          ${kitList}
          ${svcList}
          ${
            built.hasHardware
              ? `<li><strong>Hardware (one-time)</strong><strong class="price">${money(built.kitTotalChf)}</strong></li>`
              : ""
          }
          ${
            built.hasServices
              ? `<li><strong>Services</strong><strong class="price">${money(built.servicesMonthlyChf)}/mo</strong></li>`
              : ""
          }
        </ul>
        ${modeHint}
      </div>
      <form class="card" method="post" action="/order/checkout">
        <input type="hidden" name="rack" value="${escapeHtml(rack)}" />
        <input type="hidden" name="storage" value="${escapeHtml(storage)}" />
        <input type="hidden" name="kit" value="${withKit ? "1" : "0"}" />
        <input type="hidden" name="services" value="${escapeHtml(mergedServices.join(","))}" />
        <h2>Swiss shipping / billing</h2>
        <label>Full name</label>
        <input name="name" required autocomplete="name" />
        <label>Email</label>
        <input type="email" name="email" required autocomplete="email" />
        <label>Street</label>
        <input name="street" required autocomplete="street-address" />
        <div class="grid grid-2">
          <div>
            <label>PLZ</label>
            <input name="zip" required pattern="[0-9]{4}" autocomplete="postal-code" />
          </div>
          <div>
            <label>City</label>
            <input name="city" required autocomplete="address-level2" />
          </div>
        </div>
        <label>Canton (optional)</label>
        <input name="canton" autocomplete="address-level1" />
        <p class="muted">Country: Switzerland (CH)</p>
        <p style="margin-top:1.25rem">
          <button class="btn" type="submit" ${paymentsConfigured ? "" : "disabled"}>${
            paymentsConfigured ? "Pay with Stripe" : "Payments not configured"
          }</button>
          <a class="btn secondary" href="/kit">Edit kit</a>
          <a class="btn secondary" href="/services?${withKit ? `kit=1&rack=${encodeURIComponent(rack)}&storage=${encodeURIComponent(storage)}&` : ""}services=${encodeURIComponent(mergedServices.join(","))}">Edit services</a>
        </p>
      </form>`,
    }),
  );
});

app.post("/order/checkout", async (req, res) => {
  const rack = req.body.rack || "none";
  const storage = req.body.storage || "none";
  const withKit = req.body.kit !== "0" && req.body.kit !== "false";
  const serviceIds = parseServiceIds(req.body.services);
  const address = {
    name: String(req.body.name || "").trim(),
    email: String(req.body.email || "").trim(),
    street: String(req.body.street || "").trim(),
    zip: String(req.body.zip || "").trim(),
    city: String(req.body.city || "").trim(),
    canton: String(req.body.canton || "").trim(),
    country: "CH",
  };

  const built = buildStripeCheckout({
    includeKit: withKit,
    rack,
    storage,
    serviceIds,
  });

  if (!built.line_items.length) {
    return res.status(400).type("html").send(
      layout({
        title: "Empty order",
        body: `<div class="alert warn">Nothing to checkout.</div><p><a href="/order">Back</a></p>`,
      }),
    );
  }

  if (!paymentsConfigured || !stripe) {
    return res.status(503).type("html").send(
      layout({
        title: "Payments not configured",
        body: `${paymentsBanner()}<p><a href="/order">Back</a></p>`,
      }),
    );
  }

  const cancelQs = new URLSearchParams({
    kit: withKit ? "1" : "0",
    rack,
    storage,
    services: serviceIds.join(","),
  });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: built.mode,
      customer_email: address.email,
      line_items: built.line_items,
      success_url: `${SITE_URL}/order/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/order?${cancelQs.toString()}`,
      metadata: {
        kit: withKit ? "1" : "0",
        rack,
        storage,
        services: serviceIds.join(","),
        kitTotalChf: String(built.kitTotalChf),
        servicesMonthlyChf: String(built.servicesMonthlyChf),
        addOns: built.addOnsMeta || "",
        ship_name: address.name,
        ship_street: address.street,
        ship_zip: address.zip,
        ship_city: address.city,
        ship_canton: address.canton,
        ship_country: "CH",
      },
      shipping_address_collection: withKit ? { allowed_countries: ["CH"] } : undefined,
    });
    return res.redirect(303, session.url);
  } catch (err) {
    console.error("[stripe]", err);
    return res.status(500).type("html").send(
      layout({
        title: "Checkout error",
        body: `<div class="alert warn">Could not start Stripe Checkout. Check server logs and keys.</div><p><a href="/order">Back</a></p>`,
      }),
    );
  }
});

app.get("/order/thanks", (req, res) => {
  const sid = req.query.session_id ? String(req.query.session_id) : "";
  res.type("html").send(
    layout({
      title: "Thank you",
      body: `
      <div class="alert ok"><strong>Order received.</strong> Thank you for supporting Heimcloud.</div>
      <div class="card">
        <h1>What happens next</h1>
        <p>Hardware fulfills in a <strong>month-end batch</strong>. Subscriptions renew monthly until cancelled.</p>
        ${sid ? `<p class="muted">Stripe session: <code>${escapeHtml(sid)}</code></p>` : ""}
        <p><a class="btn" href="/">Home</a></p>
      </div>`,
    }),
  );
});

app.get("/legal", (_req, res) => {
  res.type("html").send(
    layout({
      title: "Legal",
      body: `
      <h1>Legal stubs</h1>
      <div class="card">
        <h2>Impressum</h2>
        <p class="muted">Heimcloud — Switzerland. Replace with legal entity details before go-live.</p>
      </div>
      <div class="card">
        <h2>Privacy / Datenschutz</h2>
        <p class="muted">We process order data (name, address, email) to fulfill kits. Stripe processes payments. Full policy TBD.</p>
      </div>
      <div class="card">
        <h2>AGB</h2>
        <p class="muted">CHF only. CH shipping. Month-end batch fulfillment for hardware. Services are monthly subscriptions. Returns / warranty text TBD.</p>
      </div>`,
    }),
  );
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, paymentsConfigured });
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Heimcloud shop listening on :${PORT} (payments=${paymentsConfigured})`);
});
