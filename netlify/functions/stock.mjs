import { json, editions, soldCount, PRODUCTS, FORMATS, EDITION, key } from "../lib/shop.mjs";
export default async () => {
  const store = editions();
  const sold = {};
  for (const p of Object.keys(PRODUCTS)) for (const f of Object.keys(FORMATS)) sold[key(p, f)] = await soldCount(store, key(p, f));
  return json({ edition: EDITION, sold });
};
export const config = { path: "/api/stock" };
