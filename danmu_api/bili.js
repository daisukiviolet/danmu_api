// danmu_api/bili.js
// 独立的 B 站源路由：/bili/api/v2/*
//
// 背景：B 站 x/web-interface/search/type?search_type=media_ft（影视搜索）
// 对机房 IP 直接返回 code:0 + result:[] —— 不报错、不给 403，静默空数组。
// 表现就是「番剧搜得到、电影搜不到」。
// 但同一出口访问 pgc/view/web/season 与弹幕接口是通的（实测 3208 条 / 1.4s）。
// 所以这里只把「搜索」这一环换掉，其余全走原有逻辑。
//
// 播放器里填： https://<域名>/bili

// package.json 是 type:module，只能用 import，不能用 require
import crypto from "node:crypto";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REF = "https://www.bilibili.com/";

// B 站 Android 客户端公开 appkey（社区长期在用，非本项目私有凭据）
const APP_KEY = "1d8b6e7d45233436";
const APP_SEC = "560c52ccd288fed045859ed18bffd973";

const UPSTREAM_TIMEOUT_MS = 8000;

// CDN 缓存：搜索 30 分钟，详情 6 小时，弹幕 10 分钟
const TTL_RULES = [
  [/^\/v2\/comment\//i, 600],
  [/^\/v2\/search\//i, 1800],
  [/^\/v2\/bangumi\//i, 21600],
  [/^\/v2\/match/i, 1800],
];
function ttlFor(path) {
  for (const [re, ttl] of TTL_RULES) if (re.test(path)) return ttl;
  return 600;
}

async function bfetch(url, { method = "GET", body = null, headers = {}, timeout = UPSTREAM_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        "User-Agent": UA,
        Referer: REF,
        Origin: "https://www.bilibili.com",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Accept: "application/json, text/plain, */*",
        ...headers,
      },
      body: body || undefined,
      signal: ctl.signal,
      redirect: "follow",
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, buf };
  } finally {
    clearTimeout(timer);
  }
}

async function bjson(url, opts = {}) {
  const { status, buf } = await bfetch(url, opts);
  try {
    return { status, json: JSON.parse(buf.toString("utf8")) };
  } catch {
    return { status, json: null, raw: buf.slice(0, 200).toString("utf8") };
  }
}

// ---------- wbi 签名（B 站 2023 起对 web 搜索加了 w_rid 校验） ----------
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

let _mixin = { key: null, exp: 0 };

async function getMixinKey() {
  const now = Date.now();
  if (_mixin.key && now < _mixin.exp) return _mixin.key;
  const { json } = await bjson("https://api.bilibili.com/x/web-interface/nav");
  const wi = (json && json.data && json.data.wbi_img) || {};
  const img = String(wi.img_url || "").split("/").pop().split(".")[0];
  const sub = String(wi.sub_url || "").split("/").pop().split(".")[0];
  if (!img || !sub) return null;
  const orig = img + sub;
  const key = MIXIN_TAB.map((i) => orig[i] || "").join("").slice(0, 32);
  // key 每天轮换一次，缓存 6 小时足够
  _mixin = { key, exp: now + 6 * 3600 * 1000 };
  return key;
}

function md5Hex(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

async function signedWbi(params) {
  const mixin = await getMixinKey();
  if (!mixin) return null;
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
    .join("&");
  p.w_rid = md5Hex(q + mixin);
  return Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
    .join("&");
}

function signedApp(params) {
  const p = { ...params, appkey: APP_KEY, ts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
    .join("&");
  p.sign = md5Hex(q + APP_SEC);
  return Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
    .join("&");
}

// ---------- 搜索：多入口 fallback ----------
function stripEm(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .trim();
}

// 入口 1：web 搜索 media_ft / media_bangumi（已知对机房 IP 常返空）
async function viaWebSearch(keyword, searchType) {
  const qs = await signedWbi({ keyword, search_type: searchType });
  if (!qs) return [];
  const { json } = await bjson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`);
  const res = (json && json.data && json.data.result) || [];
  return res
    .filter((r) => r.season_id)
    .map((r) => ({
      seasonId: String(r.season_id),
      title: stripEm(r.title),
      typeName: r.season_type_name || "",
      epSize: Number(r.ep_size) || 0,
      cover: String(r.cover || "").replace(/^\/\//, "https://"),
      from: "web-" + searchType,
    }));
}

// 入口 2：PGC 季库搜索（番剧/影视/纪录片/国创/电视剧）
async function viaPgcSearch(keyword) {
  const out = [];
  for (const st of [1, 2, 3, 4, 5, 7]) {
    const qs = await signedWbi({ season_type: st, keyword, page: 1, page_size: 20 });
    const url = qs
      ? `https://api.bilibili.com/pgc/season/search/list?${qs}`
      : `https://api.bilibili.com/pgc/season/search/list?season_type=${st}&keyword=${encodeURIComponent(keyword)}&page=1&page_size=20`;
    const { json } = await bjson(url);
    const list = (json && json.data && (json.data.list || json.data.result)) || [];
    for (const r of list) {
      if (!r.season_id) continue;
      out.push({
        seasonId: String(r.season_id),
        title: stripEm(r.title),
        typeName: r.season_type_name || r.season_type || "",
        epSize: Number(r.total_count || r.ep_size || 0) || 0,
        cover: String(r.cover || "").replace(/^\/\//, "https://"),
        from: "pgc",
      });
    }
  }
  return out;
}

// 入口 3：App 端搜索（type=7 影视，type=1 番剧），App 通道风控最弱
async function viaAppSearch(keyword) {
  const out = [];
  for (const t of [7, 1]) {
    const qs = signedApp({
      keyword,
      type: t,
      build: 7840300,
      mobi_app: "android",
      platform: "android",
      c_locale: "zh_CN",
      s_locale: "zh_CN",
      ts: Math.floor(Date.now() / 1000),
    });
    const { json } = await bjson(`https://app.bilibili.com/x/v2/search/type?${qs}`);
    const items = (json && json.data && (json.data.items || json.data.result)) || [];
    for (const r of items) {
      const sid = r.season_id || r.seasonId;
      if (!sid) continue;
      out.push({
        seasonId: String(sid),
        title: stripEm(r.title),
        typeName: r.season_type_name || (t === 1 ? "番剧" : "影视"),
        epSize: Number(r.ep_size || r.total_count || 0) || 0,
        cover: String(r.cover || "").replace(/^\/\//, "https://"),
        from: "app",
      });
    }
  }
  return out;
}

async function searchAll(keyword) {
  const results = [];
  const push = (arr) => {
    for (const it of arr) {
      if (!it.seasonId) continue;
      const dup = results.find((x) => x.seasonId === it.seasonId);
      if (dup) {
        // 同一季被多个入口命中时，补上更全的集数信息
        if (!dup.epSize && it.epSize) dup.epSize = it.epSize;
        if (!dup.typeName && it.typeName) dup.typeName = it.typeName;
        dup.from += "+" + it.from;
      } else {
        results.push(it);
      }
    }
  };

  // 三个入口并行，任一有结果即可用；全部空才是真无结果
  const [w1, w2, app, pgc] = await Promise.allSettled([
    viaWebSearch(keyword, "media_ft"),
    viaWebSearch(keyword, "media_bangumi"),
    viaAppSearch(keyword),
    viaPgcSearch(keyword),
  ]);
  for (const r of [w1, w2, app, pgc]) if (r.status === "fulfilled") push(r.value);

  return results;
}

// ---------- 分集：pgc/view/web/season ----------
async function getSeasonEpisodes(seasonId) {
  const { json } = await bjson(
    `https://api.bilibili.com/pgc/view/web/season?season_id=${encodeURIComponent(seasonId)}`
  );
  const r = (json && json.result) || null;
  if (!r) return null;

  const main = Array.isArray(r.episodes) ? r.episodes : [];
  const sections = [];
  for (const s of r.section || []) {
    for (const e of s.episodes || []) sections.push(e);
  }
  const all = [...main, ...sections].filter((e) => e && e.id);

  // 去重（正片与花絮可能重叠）
  const seen = new Set();
  const eps = [];
  for (const e of all) {
    const key = String(e.id);
    if (seen.has(key)) continue;
    seen.add(key);
    eps.push(e);
  }

  return {
    seasonId: String(r.season_id || seasonId),
    title: stripEm(r.title),
    typeName: r.type_name || r.season_type_name || "",
    cover: String(r.cover || "").replace(/^\/\//, "https://"),
    total: Number(r.total) || eps.length,
    episodes: eps.map((e, idx) => ({
      epId: String(e.id),
      cid: String(e.cid || ""),
      aid: String(e.aid || ""),
      title:
        stripEm(e.title) +
        (e.long_title && String(e.long_title).trim() && stripEm(e.long_title) !== stripEm(e.title)
          ? " " + stripEm(e.long_title)
          : ""),
      index: Number(e.title) || idx + 1,
      duration: Number(e.duration) || 0,
    })),
  };
}

// ---------- 弹幕：转发给 worker 的 comment?url=（该路径已验证可达） ----------
function guessHost(req) {
  const h = req.headers["x-forwarded-host"] || req.headers.host || "";
  return String(h).split(",")[0].trim();
}

function guessProto(req) {
  return String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
}

async function forwardComment(req, epId) {
  const host = guessHost(req);
  const proto = guessProto(req);
  const token = process.env.TOKEN || "";
  const prefix = token ? `/${token}` : "";
  const inner =
    `${proto}://${host}${prefix}/api/v2/comment?url=` +
    encodeURIComponent(`https://www.bilibili.com/bangumi/play/ep${epId}`) +
    "&withRelated=true&chConvert=0";
  const { status, buf } = await bfetch(inner, { timeout: 30000 });
  return { status, buf };
}

// ---------- HTTP 辅助 ----------
function send(res, status, obj, cacheSec = 0, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cacheSec > 0) {
    res.setHeader("Cache-Control", `public, s-maxage=${cacheSec}, stale-while-revalidate=86400`);
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// ---------- 探测：从 Vercel 真实出口测各入口可达性 ----------
// 只允许白名单域名，避免变成开放代理
const PROBE_ALLOW = [
  "api.bilibili.com",
  "app.bilibili.com",
  "s.search.bilibili.com",
  // 排查国内源从 Vercel 出口的连通性
  "api.so.360kan.com",
  "api.gorafie.com",
  "api.pleasfun.com",
  "search.youku.com",
  "mesh.if.iqiyi.com",
];
async function handleProbe(res, target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return send(res, 400, { success: false, errorMessage: "bad url" });
  }
  if (!PROBE_ALLOW.includes(u.hostname)) {
    return send(res, 403, { success: false, errorMessage: "host not allowed: " + u.hostname });
  }
  const t0 = Date.now();
  try {
    const { status, buf } = await bfetch(u.toString(), { timeout: 10000 });
    const text = buf.toString("utf8");
    let summary = { bytes: buf.length };
    try {
      const j = JSON.parse(text);
      summary.code = j.code;
      summary.message = j.message;
      const d = j.data || j.result || {};
      summary.numResults = d.numResults ?? d.num ?? null;
      summary.resultLen = Array.isArray(d.result) ? d.result.length : Array.isArray(d.items) ? d.items.length : Array.isArray(d.list) ? d.list.length : null;
      summary.titles = (
        d.result || d.items || d.list || []
      ).slice(0, 4).map((x) => String(x.title || x.name || "").replace(/<[^>]+>/g, "").slice(0, 26));
    } catch {
      summary.head = text.slice(0, 120);
    }
    return send(res, 200, { success: true, status, ms: Date.now() - t0, ...summary });
  } catch (e) {
    return send(res, 200, {
      success: false,
      ms: Date.now() - t0,
      error: (e && e.message) || String(e),
    });
  }
}

export default async function handler(req, res) {
  const rawUrl = req.url || "/";
  const qi = rawUrl.indexOf("?");
  let path = qi >= 0 ? rawUrl.slice(0, qi) : rawUrl;
  const query = qi >= 0 ? rawUrl.slice(qi + 1) : "";
  const sp = new URLSearchParams(query);

  // 探测入口
  if (path === "/bili/_probe" || path === "/_probe") {
    return handleProbe(res, sp.get("u") || "");
  }

  // 剥前缀
  if (path.startsWith("/bili")) path = path.slice(5);
  if (!path.startsWith("/")) path = "/" + path;
  if (path.startsWith("/api/")) path = path.slice(4);

  // 健康检查
  if (path === "/" || path === "") {
    return send(res, 200, {
      service: "danmu_api bili mount",
      note: "B 站独立源：搜索绕过 media_ft 风控，弹幕走官方接口",
      selfTest: "/bili/api/v2/search/episodes?anime=蜘蛛侠",
      probe: "/bili/_probe?u=<urlencoded bilibili api url>",
    });
  }

  // ---- 搜索 ----
  if (path === "/v2/search/episodes") {
    const anime = (sp.get("anime") || "").trim();
    const epNo = sp.get("episode");
    if (!anime) return send(res, 200, { success: false, errorCode: 400, errorMessage: "anime required", animes: [] });

    try {
      let list = await searchAll(anime);
      // 关键词太长（文件名整串）时退回前 12 字再搜一次
      if (list.length === 0 && anime.length > 12) {
        list = await searchAll(anime.slice(0, 12));
      }
      const animes = [];
      // 最多取 8 个候选的分集，避免一次搜索打太多请求把函数拖过 10s
      for (const it of list.slice(0, 8)) {
        let detail = null;
        try {
          detail = await getSeasonEpisodes(it.seasonId);
        } catch {
          detail = null;
        }
        if (!detail || detail.episodes.length === 0) {
          animes.push({
            animeId: Number(it.seasonId) || 0,
            animeTitle: `${it.title}【${it.typeName || "B站"}】from bili`,
            type: "bili",
            typeDescription: it.typeName || "",
            episodes: [],
          });
          continue;
        }
        const eps = detail.episodes
          .filter((e) => (epNo ? String(e.index) === String(epNo) || e.title.includes(String(epNo)) : true))
          .map((e) => ({
            episodeId: e.epId,
            episodeTitle: e.title,
            episodeNumber: String(e.index),
            url: `https://www.bilibili.com/bangumi/play/ep${e.epId}`,
          }));
        animes.push({
          animeId: Number(it.seasonId) || 0,
          animeTitle: `${detail.title || it.title}【${detail.typeName || it.typeName || "B站"}】from bili`,
          type: "bili",
          typeDescription: detail.typeName || it.typeName || "",
          episodes: eps.length ? eps : detail.episodes.map((e) => ({
            episodeId: e.epId,
            episodeTitle: e.title,
            episodeNumber: String(e.index),
            url: `https://www.bilibili.com/bangumi/play/ep${e.epId}`,
          })),
        });
      }
      return send(res, 200, { success: true, errorCode: 0, errorMessage: "", animes }, ttlFor("/v2/search/"));
    } catch (e) {
      return send(res, 502, {
        success: false,
        errorCode: -1,
        errorMessage: "bili search error: " + ((e && e.message) || String(e)),
        animes: [],
      });
    }
  }

  // ---- 番剧详情 ----
  if (path.startsWith("/v2/bangumi/")) {
    const id = decodeURIComponent(path.slice("/v2/bangumi/".length));
    try {
      const d = await getSeasonEpisodes(id);
      if (!d) {
        return send(res, 404, { errorCode: 404, success: false, errorMessage: "Anime not found", bangumi: null });
      }
      return send(
        res,
        200,
        {
          success: true,
          errorCode: 0,
          errorMessage: "",
          bangumi: {
            animeId: Number(d.seasonId) || 0,
            animeTitle: d.title,
            type: "bili",
            typeDescription: d.typeName,
            episodes: d.episodes.map((e) => ({
              episodeId: e.epId,
              episodeTitle: e.title,
              episodeNumber: String(e.index),
              url: `https://www.bilibili.com/bangumi/play/ep${e.epId}`,
            })),
          },
        },
        ttlFor("/v2/bangumi/")
      );
    } catch (e) {
      return send(res, 502, { success: false, errorCode: -1, errorMessage: String((e && e.message) || e), bangumi: null });
    }
  }

  // ---- 弹幕：episodeId 或 url ----
  if (path.startsWith("/v2/comment")) {
    let epId = "";
    if (path.startsWith("/v2/comment/")) {
      epId = decodeURIComponent(path.slice("/v2/comment/".length)).replace(/[^\d]/g, "");
    } else {
      const u = sp.get("url") || "";
      const m = String(u).match(/ep(\d+)/i);
      if (m) epId = m[1];
      const m2 = String(u).match(/ss(\d+)/i);
      if (!epId && m2) {
        const d = await getSeasonEpisodes(m2[1]);
        if (d && d.episodes.length) epId = d.episodes[0].epId;
      }
      if (!epId) {
        const m3 = String(u).match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (m3) {
          // 普通投稿：交给 worker 处理，它对 BV 号有专门分支
          const inner =
            `${guessProto(req)}://${guessHost(req)}${process.env.TOKEN ? "/" + process.env.TOKEN : ""}` +
            `/api/v2/comment?url=${encodeURIComponent(u)}&withRelated=true&chConvert=0`;
          const r = await bfetch(inner, { timeout: 30000 });
          res.statusCode = r.status;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          return res.end(r.buf);
        }
      }
    }
    if (!epId) {
      return send(res, 200, { count: 0, comments: [], errorCode: 0, errorMessage: "" });
    }
    try {
      const r = await forwardComment(req, epId);
      res.statusCode = r.status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (r.status === 200) {
        res.setHeader("Cache-Control", `public, s-maxage=${ttlFor("/v2/comment/")}, stale-while-revalidate=86400`);
      } else {
        res.setHeader("Cache-Control", "no-store");
      }
      return res.end(r.buf);
    } catch (e) {
      return send(res, 502, { count: 0, comments: [], errorCode: -1, errorMessage: String((e && e.message) || e) });
    }
  }

  // ---- 文件识别：用文件名前段做关键词搜索 ----
  if (path === "/v2/match" && req.method === "POST") {
    try {
      const raw = (await readBody(req)).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      const fileName = String(body.fileName || "");
      const kw = fileName
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\.(mkv|mp4|avi|ts|mov|flv|wmv|rmvb|webm)$/i, " ")
        .replace(/[._]/g, " ")
        .replace(/\b(S\d{1,2}E\d{1,3}|EP?\d{1,3}|\d{3,4}[pP]|WEB-?DL|BluRay|HEVC|x26[45]|AAC|DTS|10bit)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      const list = await searchAll(kw);
      const first = list[0];
      if (!first) return send(res, 200, { success: true, errorCode: 0, isMatched: false, matches: [] });
      const d = await getSeasonEpisodes(first.seasonId);
      const m = fileName.match(/\bS(\d{1,2})E(\d{1,3})\b/i) || fileName.match(/\bEP?(\d{1,3})\b/i);
      const wantEp = m ? Number(m[2] || m[1]) : 0;
      const ep = d && d.episodes.find((e) => e.index === wantEp);
      return send(res, 200, {
        success: true,
        errorCode: 0,
        isMatched: !!(d && ep),
        matches: d
          ? [
              {
                animeId: Number(d.seasonId) || 0,
                animeTitle: d.title,
                type: "bili",
                typeDescription: d.typeName,
                episodeId: ep ? ep.epId : d.episodes[0] ? d.episodes[0].epId : "",
                episodeTitle: ep ? ep.title : d.episodes[0] ? d.episodes[0].title : "",
                shift: 0,
              },
            ]
          : [],
      });
    } catch (e) {
      return send(res, 502, { success: false, errorCode: -1, isMatched: false, errorMessage: String((e && e.message) || e), matches: [] });
    }
  }

  return send(res, 404, { success: false, errorCode: 404, errorMessage: "bili: unsupported path " + path });
}
