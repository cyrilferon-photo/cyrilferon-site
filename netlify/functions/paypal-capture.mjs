import { json, orders, pending, assignNumbers, ZONES } from "../lib/shop.mjs";
import { PP_BASE, ppToken } from "../lib/paypal.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  let orderID, token;
  try { ({ orderID } = await req.json()); token = await ppToken(); } catch (e) { return json({ error: e.message }, 400); }
  if (!/^[A-Z0-9]{8,32}$/.test(String(orderID))) return json({ error: "Commande invalide." }, 400);
  const store = orders(), id = `paypal_${orderID}`;
  const done = await store.get(id, { type: "json" });
  if (done) return json({ ok: true, lines: done.lines });
  const cart = await pending().get(orderID, { type: "json" });
  if (!cart) return json({ error: "Commande inconnue." }, 404);
  const r = await fetch(`${PP_BASE()}/v2/checkout/orders/${orderID}/capture`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const d = await r.json();
  if (!r.ok || d.status !== "COMPLETED") { console.error("paypal capture", d); return json({ error: "Le paiement PayPal n’a pas abouti." }, 402); }
  const pu = d.purchase_units?.[0] || {};
  const country = pu.shipping?.address?.country_code;
  const lines = await assignNumbers(cart.lines);
  await store.setJSON(id, {
    provider: "paypal",
    id: orderID,
    capture: pu.payments?.captures?.[0]?.id,
    date: new Date().toISOString(),
    zone: cart.zone,
    zoneMismatch: Boolean(country && !ZONES[cart.zone].countries.includes(country)),
    email: d.payer?.email_address,
    name: [d.payer?.name?.given_name, d.payer?.name?.surname].filter(Boolean).join(" "),
    shipping: pu.shipping || null,
    total: cart.total,
    lines,
  });
  await pending().delete(orderID);
  return json({ ok: true, lines });
};
export const config = { path: "/api/paypal-capture" };
