// danmu_api/ddp.js
// 独立挂载的弹弹play 镜像路由：/ddp/api/v2/* -> danmaku-anywhere 网关
//
// 设计原则：完全不碰原有 /api/v2/* 的逻辑。
// 原有源（renren / 360 / bilibili ...）照常工作，这里只是多开一条纯粹走弹弹play
// 弹幕库的通道，供播放器当作一个独立源添加。
//
// 部署后播放器里填： https://<你的域名>/ddp
// 实际请求形如：     https://<你的域名>/ddp/api/v2/comment/95410001?withRelated=true

const UPSTREAM = "https://api.danmaku.weeblify.app/ddp/v1";

// 网关前面挂着 Cloudflare：Node 默认 UA 会被 403（error code 1010），
// 必须伪装成浏览器 UA。实测 curl / Chrome / Dart 都放行，只拦 Python-urllib 和 node-fetch 默认值。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// CDN 缓存 TTL（秒）。弹幕库几乎不变，缓存越久，网关压力和响应延迟越低。
const TTL_RULES = [
  [/^\/v2\/comment\//i, 21600],   // 6 小时
  [/^\/v2\/search\//i, 3600],     // 1 小时
  [/^\/v2\/bangumi\//i, 86400],   // 1 天
  [/^\/v2\/match/i, 3600],
];

function ttlFor(path) {
  for (const [re, ttl] of TTL_RULES) {
    if (re.test(path)) return ttl;
  }
  return 600;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const rawUrl = req.url || "/";
  const qIndex = rawUrl.indexOf("?");
  let path = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
  const query = qIndex >= 0 ? rawUrl.slice(qIndex + 1) : "";

  // 剥掉挂载前缀 /ddp，再剥掉 /api —— 网关的 path 参数是 /v2/xxx，没有 /api
  if (path === "/ddp" || path === "/ddp/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        service: "danmu_api ddp mount",
        upstream: UPSTREAM,
        usage: "把 /ddp 填到播放器的「弹幕 API 基础地址」，请求会转发到 " + UPSTREAM,
        selfTest: "/ddp/api/v2/search/episodes?anime=进击的巨人",
      })
    );
    return;
  }

  if (path.startsWith("/ddp/")) path = path.slice(4);
  if (path.startsWith("/api/")) path = path.slice(4);

  if (!path.startsWith("/v2/")) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ success: false, errorMessage: "ddp: unsupported path " + path }));
    return;
  }

  const inner = path + (query ? "?" + query : "");
  const target = UPSTREAM + "?path=" + encodeURIComponent(inner);

  let body;
  if (req.method === "POST" || req.method === "PUT") {
    body = await readBody(req);
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        "User-Agent": UA,
        "Content-Type": req.headers["content-type"] || "application/json",
        "Accept-Encoding": "identity",
      },
      body: body && body.length ? body : undefined,
    });

    const buf = Buffer.from(await upstream.arrayBuffer());

    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");

    // 只缓存成功且幂等的 GET；POST（文件识别）一律不缓存
    if (upstream.status === 200 && req.method === "GET") {
      res.setHeader(
        "Cache-Control",
        `public, s-maxage=${ttlFor(path)}, stale-while-revalidate=86400`
      );
    } else {
      res.setHeader("Cache-Control", "no-store");
    }

    const upstreamErr = upstream.headers.get("x-error-message");
    if (upstreamErr) res.setHeader("X-Error-Message", upstreamErr);

    res.end(buf);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        success: false,
        errorCode: -1,
        errorMessage: "ddp upstream error: " + (e && e.message ? e.message : String(e)),
      })
    );
  }
}
