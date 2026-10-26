import { json, editions, soldCount, getCatalog, FORMATS, key } from "../lib/shop.mjs";
export default async () => {
  const store = editions();
  const sold = {};
  const CAT = await getCatalog();
  for (const p of Object.keys(CAT)) for (const f of Object.keys(FORMATS)) sold[key(p, f)] = await soldCount(store, key(p, f));
  return json({ editions: Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => [k, f.edition])), sold });
};
export const config = { path: "/api/stock" };
