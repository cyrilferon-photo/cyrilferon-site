// Reçu de Stripe quand un paiement est confirmé : attribue les numéros et enregistre la commande.
import crypto from "node:crypto";
import { json, orders, assignNumbers, expandCartMeta } from "../lib/shop.mjs";

function verify(raw, header, secret) {
  const parts = Object.fromEntries(String(header || "").split(",").map((s) => s.split("=")).filter((a) => a.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = String(header || "").split(",").filter((s) => s.trim().startsWith("v1=")).map((s) => s.trim().slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

export default async (req) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ error: "not configured" }, 503);
  const raw = await req.text();
  if (!verify(raw, req.headers.get("stripe-signature"), secret)) return json({ error: "bad signature" }, 400);
  const event = JSON.parse(raw);
  const s = event.data?.object;
  const paid = (event.type === "checkout.session.completed" && s?.payment_status === "paid") || event.type === "checkout.session.async_payment_succeeded";
  if (!paid) return json({ received: true });
  const store = orders();
  const id = `stripe_${s.id}`;
  if (await store.get(id)) return json({ received: true, duplicate: true });
  const lines = await assignNumbers(await expandCartMeta(s.metadata));
  await store.setJSON(id, {
    provider: "stripe",
    id: s.id,
    payment: s.payment_intent,
    date: new Date().toISOString(),
    zone: s.metadata?.zone,
    email: s.customer_details?.email,
    name: s.customer_details?.name,
    phone: s.customer_details?.phone,
    shipping: s.collected_information?.shipping_details || s.shipping_details || null,
    total: (s.amount_total || 0) / 100,
    lines,
  });
  return json({ received: true });
};
export const config = { path: "/api/stripe-webhook" };
