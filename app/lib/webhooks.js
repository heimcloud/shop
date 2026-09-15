/**
 * Stripe webhook handlers — persist customers/orders/entitlements + stub provisioning jobs.
 * No real xAI / rsync / AirVPN / Hostkey API calls.
 */
import { STRIPE_PRICES, SERVICES } from "./prices.js";
import {
  claimWebhookEvent,
  upsertCustomer,
  insertOrder,
  upsertEntitlement,
  insertProvisioningJob,
} from "./db.js";

/** Reverse map Stripe Price ID → service_id (public_ip|airvpn|hermes|backups). */
function priceToServiceId() {
  const map = {};
  for (const [serviceId, priceId] of Object.entries(STRIPE_PRICES)) {
    if (serviceId === "kit") continue;
    map[priceId] = serviceId;
  }
  return map;
}

function periodEndIso(unixSec) {
  if (unixSec == null) return null;
  const n = Number(unixSec);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

function kitConfigFromMeta(meta = {}) {
  return {
    kit: meta.kit || "0",
    rack: meta.rack || "none",
    storage: meta.storage || "none",
    services: meta.services || "",
    addOns: meta.addOns || "",
    kitTotalChf: meta.kitTotalChf || "",
    servicesMonthlyChf: meta.servicesMonthlyChf || "",
    ship: {
      name: meta.ship_name || "",
      street: meta.ship_street || "",
      zip: meta.ship_zip || "",
      city: meta.ship_city || "",
      canton: meta.ship_canton || "",
      country: meta.ship_country || "CH",
    },
  };
}

function servicesFromMeta(meta = {}) {
  const raw = String(meta.services || "")
    .split(",")
    .map((s) => s.trim())
    .filter((id) => SERVICES[id]);
  return [...new Set(raw)];
}

/**
 * Process a verified Stripe event. Idempotent on event.id.
 * @returns {{ ok: boolean, duplicate?: boolean, handled?: boolean }}
 */
export async function handleStripeEvent(stripe, event) {
  if (!claimWebhookEvent(event.id, event.type)) {
    return { ok: true, duplicate: true };
  }

  switch (event.type) {
    case "checkout.session.completed":
      await onCheckoutSessionCompleted(stripe, event.data.object);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await onSubscriptionUpsert(stripe, event.data.object);
      break;
    case "customer.subscription.deleted":
      await onSubscriptionDeleted(stripe, event.data.object);
      break;
    case "invoice.paid":
      await onInvoicePaid(stripe, event.data.object);
      break;
    default:
      return { ok: true, handled: false };
  }
  return { ok: true, handled: true };
}

async function onCheckoutSessionCompleted(stripe, session) {
  const email =
    session.customer_details?.email ||
    session.customer_email ||
    session.metadata?.email ||
    null;
  if (!email && !session.customer) {
    console.warn("[webhook] checkout.session.completed missing email/customer", session.id);
    return;
  }

  const customer = upsertCustomer({
    email: email || `unknown+${session.customer}@stripe.local`,
    stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
  });

  const meta = session.metadata || {};
  const kitConfig = kitConfigFromMeta(meta);
  const mode = session.mode === "subscription" ? "subscription" : "payment";

  let lineItemsSummary = [];
  try {
    const listed = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
    lineItemsSummary = (listed.data || []).map((li) => ({
      id: li.id,
      description: li.description,
      amount_total: li.amount_total,
      currency: li.currency,
      quantity: li.quantity,
      price: li.price?.id || null,
    }));
  } catch (err) {
    console.warn("[webhook] listLineItems failed", err.message);
  }

  const order = insertOrder({
    customerId: customer.id,
    stripeSessionId: session.id,
    mode,
    amountTotal: session.amount_total ?? null,
    currency: session.currency || "chf",
    status: session.payment_status || session.status || "completed",
    kitConfigJson: JSON.stringify(kitConfig),
    lineItemsJson: JSON.stringify(lineItemsSummary),
  });

  const priceMap = priceToServiceId();
  const serviceIds = new Set(servicesFromMeta(meta));
  for (const li of lineItemsSummary) {
    if (li.price && priceMap[li.price]) serviceIds.add(priceMap[li.price]);
  }

  let subscriptionId =
    typeof session.subscription === "string" ? session.subscription : null;
  let periodEnd = null;
  let subStatus = "active";

  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      subStatus = sub.status || "active";
      periodEnd = periodEndIso(sub.current_period_end);
      for (const item of sub.items?.data || []) {
        const pid = item.price?.id;
        if (pid && priceMap[pid]) serviceIds.add(priceMap[pid]);
      }
    } catch (err) {
      console.warn("[webhook] subscription retrieve failed", err.message);
    }
  }

  for (const serviceId of serviceIds) {
    const priceId = STRIPE_PRICES[serviceId] || null;
    upsertEntitlement({
      customerId: customer.id,
      serviceId,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: priceId,
      status: subStatus,
      currentPeriodEnd: periodEnd,
    });
  }

  // Stub provisioning job — Credentials / Hostkey / AirVPN / xAI later.
  insertProvisioningJob({
    customerId: customer.id,
    orderId: order.id,
    jobType: "provision_stub",
    payloadJson: JSON.stringify({
      email: customer.email,
      services: [...serviceIds],
      kit_config: kitConfig,
      stripe_session_id: session.id,
      stripe_subscription_id: subscriptionId,
      note: "Stub only — no real provider API calls",
    }),
    status: "pending",
  });
}

async function resolveCustomerFromSubscription(stripe, subscription) {
  let stripeCustomerId =
    typeof subscription.customer === "string" ? subscription.customer : null;
  let email = subscription.metadata?.email || null;

  if (!email && stripeCustomerId) {
    try {
      const c = await stripe.customers.retrieve(stripeCustomerId);
      if (c && !c.deleted) email = c.email || null;
    } catch (err) {
      console.warn("[webhook] customer retrieve failed", err.message);
    }
  }

  if (!email && !stripeCustomerId) return null;
  return upsertCustomer({
    email: email || `unknown+${stripeCustomerId}@stripe.local`,
    stripeCustomerId,
  });
}

async function onSubscriptionUpsert(stripe, subscription) {
  const customer = await resolveCustomerFromSubscription(stripe, subscription);
  if (!customer) {
    console.warn("[webhook] subscription without customer", subscription.id);
    return;
  }

  const priceMap = priceToServiceId();
  const periodEnd = periodEndIso(subscription.current_period_end);
  const status = subscription.status || "active";
  const serviceIds = new Set(servicesFromMeta(subscription.metadata || {}));

  for (const item of subscription.items?.data || []) {
    const pid = item.price?.id;
    if (pid && priceMap[pid]) {
      serviceIds.add(priceMap[pid]);
      upsertEntitlement({
        customerId: customer.id,
        serviceId: priceMap[pid],
        stripeSubscriptionId: subscription.id,
        stripePriceId: pid,
        status,
        currentPeriodEnd: periodEnd,
      });
    }
  }

  // Metadata services without matching line items still get a row.
  for (const serviceId of serviceIds) {
    upsertEntitlement({
      customerId: customer.id,
      serviceId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: STRIPE_PRICES[serviceId] || null,
      status,
      currentPeriodEnd: periodEnd,
    });
  }
}

async function onSubscriptionDeleted(stripe, subscription) {
  const customer = await resolveCustomerFromSubscription(stripe, subscription);
  if (!customer) return;

  const priceMap = priceToServiceId();
  const periodEnd = periodEndIso(subscription.current_period_end);

  for (const item of subscription.items?.data || []) {
    const pid = item.price?.id;
    if (pid && priceMap[pid]) {
      upsertEntitlement({
        customerId: customer.id,
        serviceId: priceMap[pid],
        stripeSubscriptionId: subscription.id,
        stripePriceId: pid,
        status: "canceled",
        currentPeriodEnd: periodEnd,
      });
    }
  }

  for (const serviceId of servicesFromMeta(subscription.metadata || {})) {
    upsertEntitlement({
      customerId: customer.id,
      serviceId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: STRIPE_PRICES[serviceId] || null,
      status: "canceled",
      currentPeriodEnd: periodEnd,
    });
  }
}

async function onInvoicePaid(stripe, invoice) {
  const stripeCustomerId =
    typeof invoice.customer === "string" ? invoice.customer : null;
  let email = invoice.customer_email || null;
  if (!email && stripeCustomerId) {
    try {
      const c = await stripe.customers.retrieve(stripeCustomerId);
      if (c && !c.deleted) email = c.email || null;
    } catch (err) {
      console.warn("[webhook] customer retrieve failed", err.message);
    }
  }
  if (!email && !stripeCustomerId) return;

  const customer = upsertCustomer({
    email: email || `unknown+${stripeCustomerId}@stripe.local`,
    stripeCustomerId,
  });

  const subscriptionId =
    typeof invoice.subscription === "string" ? invoice.subscription : null;
  if (!subscriptionId) return;

  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    await onSubscriptionUpsert(stripe, sub);
  } catch (err) {
    console.warn("[webhook] invoice.paid subscription sync failed", err.message);
  }

  // Optional stub job on paid invoice (renewals) — pending for Credentials later.
  insertProvisioningJob({
    customerId: customer.id,
    orderId: null,
    jobType: "invoice_paid_stub",
    payloadJson: JSON.stringify({
      email: customer.email,
      invoice_id: invoice.id,
      stripe_subscription_id: subscriptionId,
      amount_paid: invoice.amount_paid,
      currency: invoice.currency,
      note: "Stub only — no real provider API calls",
    }),
    status: "pending",
  });
}
