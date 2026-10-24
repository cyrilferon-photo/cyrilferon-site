// Fil Instagram via Behold, mis en cache 1 h par le CDN Netlify
// (Behold ne compte ainsi qu'une vue par heure, quel que soit le nombre de visiteurs).
const FEED = "https://feeds.behold.so/Z14F54n7vMxO5coDfGVr";
export default async () => {
  try {
    const r = await fetch(FEED);
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const posts = (Array.isArray(d) ? d : d.posts || []).slice(0, 6).map((p) => ({
      href: p.permalink,
      src: p.sizes?.medium?.mediaUrl || (p.mediaType === "VIDEO" ? p.thumbnailUrl : p.mediaUrl),
      video: p.mediaType === "VIDEO",
      alt: (p.prunedCaption || p.caption || "").slice(0, 100),
    }));
    return new Response(JSON.stringify({ posts }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=600",
        "netlify-cdn-cache-control": "public, durable, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ posts: [] }), { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
};
export const config = { path: "/api/instagram" };
