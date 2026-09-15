import express from "express";
import Stripe from "stripe";
import { layout, money } from "./lib/layout.js";
import { KIT, computeKitTotal } from "./lib/prices.js";

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
          <p class="muted">ZimaBlade base + optional rack &amp; drives. Example pricing marked clearly.</p>
          <p><span class="price">${money(KIT.base.chf)}</span> <span class="example-tag">example</span></p>
          <a href="/kit">Build kit →</a>
        </div>
        <div class="card">
          <h2>Managed services</h2>
          <p class="muted">Public IP, AirVPN, Hermes tokens, backups — light placeholders for now.</p>
          <a href="/services">See services →</a>
        </div>
      </section>`,
    }),
  );
});

app.get("/kit", (req, res) => {
  const rack = req.query.rack || "none";
  const storage = req.query.storage || "none";
  const { lines, totalChf } = computeKitTotal({ rack, storage, includeShipping: true });

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
      <h1>ZimaBlade kit <span class="example-tag">example prices</span></h1>
      <div class="banner">Month-end batch fulfillment · CH shipping ${money(KIT.shippingCh.chf)}</div>
      <form class="card" method="get" action="/kit" id="cfg">
        <label>Rack</label>
        <select name="rack" onchange="this.form.submit()">${rackOptions}</select>
        <label>Storage</label>
        <select name="storage" onchange="this.form.submit()">${storOptions}</select>
      </form>
      <div class="card">
        <h2>Summary</h2>
        <ul class="clean">
          ${lines.map((l) => `<li><span>${l.name}</span><span class="price">${money(l.chf)}</span></li>`).join("")}
          <li><strong>Total</strong><strong class="price">${money(totalChf)}</strong></li>
        </ul>
        <form method="get" action="/order">
          <input type="hidden" name="rack" value="${rack}" />
          <input type="hidden" name="storage" value="${storage}" />
          <button class="btn" type="submit">Continue to order</button>
        </form>
      </div>
      <p class="muted">Prices are placeholders for the MVP — confirm before production.</p>`,
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
  // Stub: log only — no external CRM in MVP
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

app.get("/services", (_req, res) => {
  const items = [
    { name: "Public IP", desc: "Static or routed public IPv4 for your Neo — placeholder." },
    { name: "AirVPN", desc: "VPN egress / privacy route helpers — placeholder." },
    { name: "Hermes tokens", desc: "Token top-ups for Hermes messaging — placeholder." },
    { name: "Backups", desc: "Offsite backup slots for Neo volumes — placeholder." },
  ];
  res.type("html").send(
    layout({
      title: "Services",
      body: `
      <h1>Services</h1>
      <p class="muted">Light placeholders — orderable SKUs later.</p>
      <div class="grid grid-2">
        ${items
          .map(
            (i) => `<div class="card"><h2>${i.name}</h2><p class="muted">${i.desc}</p><span class="example-tag">soon</span></div>`,
          )
          .join("")}
      </div>`,
    }),
  );
});

app.get("/order", (req, res) => {
  const rack = req.query.rack || "none";
  const storage = req.query.storage || "none";
  const { lines, totalChf } = computeKitTotal({ rack, storage, includeShipping: true });

  res.type("html").send(
    layout({
      title: "Order",
      body: `
      <h1>Order summary</h1>
      ${paymentsBanner()}
      <div class="banner">Fulfilled in the next <strong>month-end batch</strong>.</div>
      <div class="card">
        <ul class="clean">
          ${lines.map((l) => `<li><span>${l.name}</span><span class="price">${money(l.chf)}</span></li>`).join("")}
          <li><strong>Total</strong><strong class="price">${money(totalChf)}</strong></li>
        </ul>
      </div>
      <form class="card" method="post" action="/order/checkout">
        <input type="hidden" name="rack" value="${rack}" />
        <input type="hidden" name="storage" value="${storage}" />
        <h2>Swiss shipping address</h2>
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
        </p>
      </form>`,
    }),
  );
});

app.post("/order/checkout", async (req, res) => {
  const rack = req.body.rack || "none";
  const storage = req.body.storage || "none";
  const { lines, totalChf } = computeKitTotal({ rack, storage, includeShipping: true });
  const address = {
    name: String(req.body.name || "").trim(),
    email: String(req.body.email || "").trim(),
    street: String(req.body.street || "").trim(),
    zip: String(req.body.zip || "").trim(),
    city: String(req.body.city || "").trim(),
    canton: String(req.body.canton || "").trim(),
    country: "CH",
  };

  if (!paymentsConfigured || !stripe) {
    return res.status(503).type("html").send(
      layout({
        title: "Payments not configured",
        body: `${paymentsBanner()}<p><a href="/order">Back</a></p>`,
      }),
    );
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: address.email,
      line_items: lines.map((l) => ({
        quantity: 1,
        price_data: {
          currency: "chf",
          unit_amount: Math.round(l.chf * 100),
          product_data: { name: l.name },
        },
      })),
      success_url: `${SITE_URL}/order/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/order?rack=${encodeURIComponent(rack)}&storage=${encodeURIComponent(storage)}`,
      metadata: {
        rack,
        storage,
        totalChf: String(totalChf),
        ship_name: address.name,
        ship_street: address.street,
        ship_zip: address.zip,
        ship_city: address.city,
        ship_canton: address.canton,
        ship_country: "CH",
      },
      shipping_address_collection: { allowed_countries: ["CH"] },
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
        <p>We fulfill in a <strong>month-end batch</strong>. You will get a shipping update closer to dispatch.</p>
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
        <p class="muted">CHF only. CH shipping. Month-end batch fulfillment. Returns / warranty text TBD.</p>
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
