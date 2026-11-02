/**
 * Free Cloudflare Worker that makes a GitHub Release asset readable by PDF.js.
 * GitHub Release downloads redirect to a storage host that does not reliably send CORS headers,
 * so browsers refuse to let a web page read them. This Worker fetches the file server-side,
 * forwards Range requests (so only the pages being viewed are transferred) and adds CORS headers.
 *
 * Variables (Worker -> Settings -> Variables):
 *   PDF_URL          direct GitHub Release asset URL (required)
 *   ALLOWED_ORIGINS  comma-separated origins allowed to call the Worker
 *                    (default: https://addon.indevs.in)
 */
export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || "https://addon.indevs.in").split(",").map((s) => s.trim());
    const origin = request.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, ETag",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: cors });
    if (!env.PDF_URL) return new Response("PDF_URL is not configured", { status: 500, headers: cors });

    const upstreamHeaders = new Headers();
    for (const h of ["Range", "If-Range", "If-None-Match"]) {
      const v = request.headers.get(h);
      if (v) upstreamHeaders.set(h, v);
    }
    const upstream = await fetch(env.PDF_URL, {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "follow",
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set("Content-Type", "application/pdf");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "public, max-age=86400");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  },
};
