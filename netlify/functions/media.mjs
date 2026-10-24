import { getStore } from "@netlify/blobs";
export default async (req, context) => {
  const key = context.params?.key || "";
  if (!/^[A-Za-z0-9_-]{6,40}\.(jpg|png|webp)$/.test(key)) return new Response("Not found", { status: 404 });
  const r = await getStore("media").getWithMetadata(key, { type: "arrayBuffer" });
  if (!r) return new Response("Not found", { status: 404 });
  return new Response(r.data, { headers: { "content-type": r.metadata?.type || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
};
export const config = { path: "/api/media/:key" };
