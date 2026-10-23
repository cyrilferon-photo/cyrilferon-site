import { json, ZONES, EDITION } from "../lib/shop.mjs";
export default async () => json({
  stripe: Boolean(process.env.STRIPE_SECRET_KEY),
  paypalClientId: process.env.PAYPAL_CLIENT_ID || null,
  edition: EDITION,
  zones: Object.fromEntries(Object.entries(ZONES).map(([k, z]) => [k, { price: z.price, countries: z.countries }])),
});
export const config = { path: "/api/config" };
