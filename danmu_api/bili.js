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

// 片名 → season_id 映射表。B 站搜索被封的绕行方案，详见 bili-map.js 注释
import SEASON_MAP from "./bili-map.js";

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

// 入口 1：web 搜索 media_ft / media_bangumi
// 对未登录的机房 IP 会返回 code:0 + numResults:0 的空结果（静默风控）。
// 带上真实登录 Cookie 后可能放行，所以这里把 BILIBILI_COOKIE 一起发出去。
async function viaWebSearch(keyword, searchType, useCookie = false) {
  const qs = await signedWbi({ keyword, search_type: searchType });
  if (!qs) return [];
  const headers = {};
  const cookie = process.env.BILIBILI_COOKIE || "";
  // 只取其中的 SESSDATA / bili_jct / DedeUserID / buvid3，避免把无关 cookie 带上去触发校验
  if (useCookie && cookie) {
    const keep = cookie
      .split(";")
      .map((s) => s.trim())
      .filter((s) => /^(SESSDATA|bili_jct|DedeUserID|buvid3|buvid4)=/.test(s));
    if (keep.length) headers.Cookie = keep.join("; ");
  }
  const { json } = await bjson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`, { headers });
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

// 入口 1b：网页版搜索页 HTML。搜索 API 走的是接口风控，HTML 搜索页是另一套网关，
// 页面里带 SSR 数据，能直接抠出 season_id。
async function viaHtmlSearch(keyword) {
  const out = [];
  const targets = [
    `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
    `https://m.bilibili.com/search?keyword=${encodeURIComponent(keyword)}`,
    `https://search.bilibili.com/media?keyword=${encodeURIComponent(keyword)}`,
  ];
  const cookie = process.env.BILIBILI_COOKIE || "";
  const headers = { Accept: "text/html,application/xhtml+xml" };
  if (cookie) {
    const keep = cookie
      .split(";")
      .map((s) => s.trim())
      .filter((s) => /^(SESSDATA|bili_jct|DedeUserID|buvid3|buvid4)=/.test(s));
    if (keep.length) headers.Cookie = keep.join("; ");
  }

  const seen = new Set();
  for (const u of targets) {
    let html = "";
    try {
      const { buf, status } = await bfetch(u, { headers, timeout: 10000 });
      if (status !== 200) continue;
      html = buf.toString("utf8");
    } catch {
      continue;
    }
    if (!html || html.length < 500) continue;

    // 1) SSR 数据里成对出现的 season_id + title
    const re = /"season_id":(\d{2,8})[^}]{0,600}?"title":"([^"]{1,80})"/g;
    let m;
    while ((m = re.exec(html))) {
      const sid = m[1];
      if (seen.has(sid)) continue;
      seen.add(sid);
      let title = m[2];
      try {
        title = JSON.parse('"' + title + '"');
      } catch {}
      out.push({
        seasonId: sid,
        title: stripEm(title),
        typeName: "",
        epSize: 0,
        cover: "",
        from: "html",
      });
    }
    // 2) 兜底：正文里出现的 md/ss 链接
    if (out.length === 0) {
      const re2 = /(?:ss|\/bangumi\/media\/md)(\d{3,8})/g;
      while ((m = re2.exec(html))) {
        const sid = m[1];
        if (seen.has(sid)) continue;
        seen.add(sid);
        out.push({ seasonId: sid, title: keyword, typeName: "", epSize: 0, cover: "", from: "html-link" });
      }
    }
  }
  return out;
}

// 入口 1c：PGC 索引接口（与 season/search/list 是不同后端）
async function viaPgcIndex(keyword) {
  const out = [];
  for (const st of [2, 1, 5, 4, 3]) {
    const u = `https://api.bilibili.com/pgc/season/index/result?season_type=${st}&keyword=${encodeURIComponent(
      keyword
    )}&page=1&pagesize=20&order=0&st=1&sort=0&type=1&area=&year=&style=&season_version=-1&spoken_language_type=-1`;
    try {
      const { json } = await bjson(u);
      const list =
        (json && json.data && (json.data.list || json.data.result || json.data.data)) || [];
      for (const r of list) {
        if (!r.season_id) continue;
        out.push({
          seasonId: String(r.season_id),
          title: stripEm(r.title),
          typeName: r.season_type_name || "",
          epSize: Number(r.total_count || 0) || 0,
          cover: String(r.cover || "").replace(/^\/\//, "https://"),
          from: "pgc-index",
        });
      }
    } catch {
      // 单个 season_type 失败不影响其他
    }
  }
  return out;
}

// 入口 1d：其余未被 media_ft 风控覆盖的搜索通道，一次全试
async function viaAltSearch(keyword) {
  const out = [];
  const push = (arr) => {
    for (const it of arr) if (it && it.seasonId) out.push(it);
  };
  const tasks = [];

  // 老版搜索接口，不带 wbi 签名
  tasks.push(async () => {
    const u = `https://api.bilibili.com/x/web-interface/search/type?search_type=media_ft&keyword=${encodeURIComponent(keyword)}`;
    const { json } = await bjson(u);
    const res = (json && json.data && json.data.result) || [];
    return res.filter((r) => r.season_id).map((r) => ({
      seasonId: String(r.season_id), title: stripEm(r.title), typeName: r.season_type_name || "",
      epSize: Number(r.ep_size) || 0, cover: "", from: "old-ft",
    }));
  });

  // 综合搜索 all/v2
  tasks.push(async () => {
    const qs = await signedWbi({ keyword });
    if (!qs) return [];
    const { json } = await bjson(`https://api.bilibili.com/x/web-interface/wbi/search/all/v2?${qs}`);
    const groups = (json && json.data && json.data.result) || [];
    const res = [];
    for (const g of groups) for (const it of g.data || []) if (it.season_id) res.push(it);
    return res.map((r) => ({
      seasonId: String(r.season_id), title: stripEm(r.title), typeName: r.season_type_name || "",
      epSize: Number(r.ep_size) || 0, cover: "", from: "all-v2",
    }));
  });

  // App 综合搜索（与 type 搜索不同后端）
  tasks.push(async () => {
    const qs = signedApp({
      keyword, build: 7840300, mobi_app: "android", platform: "android",
      c_locale: "zh_CN", s_locale: "zh_CN",
    });
    const { json } = await bjson(`https://app.bilibili.com/x/v2/search?${qs}`);
    const items = (json && json.data && (json.data.items || json.data.result)) || [];
    const res = [];
    for (const it of items) {
      if (it.season_id) res.push(it);
      for (const sub of it.data || []) if (sub.season_id) res.push(sub);
    }
    return res.map((r) => ({
      seasonId: String(r.season_id), title: stripEm(r.title), typeName: r.season_type_name || "",
      epSize: Number(r.ep_size) || 0, cover: "", from: "app-all",
    }));
  });

  // 注意：s.search.bilibili.com/main/suggest 返回的 spid 是「搜索建议项编号」，
  // 不是 season_id，拿它当季号会拼出 animeId=5 这种无效条目。这里不作为季来源。

  const r = await Promise.allSettled(tasks.map((f) => f()));
  for (const x of r) if (x.status === "fulfilled") push(x.value);
  return out;
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

// 标题相关性判断。
// PGC 季库与 App 搜索在没有关键词命中时会回落成「热门列表」，
// 不拦的话搜「蜘蛛侠」会返回名侦探柯南。宁可返回空，也不能返回错条目。
function isRelevant(title, keyword) {
  const t = String(title || "").replace(/\s+/g, "").toLowerCase();
  const k = String(keyword || "").replace(/\s+/g, "").toLowerCase();
  if (!t || !k) return false;
  if (t.includes(k) || k.includes(t)) return true;
  // 取 min(4, 关键词长度) 个连续字符作为匹配单元。
  // 3 字会撞车：搜「不存在的片子xyz」时，PGC 回落列表里的
  // 「唤醒石头里存在的生命」因为含「存在的」被判为相关。
  const need = Math.min(4, k.length);
  if (need < 2) return false;
  for (let i = 0; i + need <= k.length; i++) {
    if (t.includes(k.slice(i, i + need))) return true;
  }
  return false;
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

  // 所有入口并行，任一有结果即可用；全部空才是真无结果
  // 排序重要性：web 带 Cookie > html 搜索页 > pgc-index > app（app 会回落热门，必须过滤）
  const settled = await Promise.allSettled([
    viaWebSearch(keyword, "media_ft", true),
    viaWebSearch(keyword, "media_bangumi", true),
    viaAltSearch(keyword),
    viaHtmlSearch(keyword),
    viaPgcIndex(keyword),
    viaAppSearch(keyword),
    viaPgcSearch(keyword),
  ]);
  // 先接 web/html/pgc-index，最后接 app/pgc 这类会串味的入口
  for (const r of settled) if (r.status === "fulfilled") push(r.value);

  // 入口污染过滤：只保留标题与关键词相关的条目
  const relevant = results.filter((r) => isRelevant(r.title, keyword));

  // 只认真搜索入口的结果。
  // pgc-index / app / pgc 这三个在关键词不命中时会把「热门列表」当结果返回，
  // 属于污染源：搜「蜘蛛侠」给「名侦探柯南」，搜不存在的片子给「唤醒石头里存在的生命」。
  // 没有真搜索入口命中时返回空数组，让调用方知道「没搜到」，而不是给一条错条目。
  const TRUSTED = /web-|old-ft|all-v2|app-all|html/;
  const trusted = relevant.filter((r) => TRUSTED.test(r.from));
  if (trusted.length === 0) return [];
  return trusted;
}

// B 站 type_name → danmaku API 的 type 取值（客户端按这个显示图标）
function mapType(typeName) {
  const t = String(typeName || "");
  if (/电影|纪录片|纪实/.test(t)) return "movie";
  if (/电视剧|番剧|国创|动画|综艺|影视/.test(t)) return "tvseries";
  return "tvseries";
}

// 片名 → ss 号：查 bili-map.js
// 先精确匹配，再按「关键词包含表项」取最长，这样带画质/组名后缀的文件名也能对上
function lookupMap(keyword) {
  const norm = (x) => String(x || "").replace(/\s+/g, "").toLowerCase();
  const k = norm(keyword);
  if (!k) return null;
  for (const [name, target] of Object.entries(SEASON_MAP)) {
    if (norm(name) === k) return target;
  }
  if (k.length < 2) return null;
  let best = null;
  for (const [name, target] of Object.entries(SEASON_MAP)) {
    const n = norm(name);
    if (!n) continue;
    if (k.includes(n) || n.includes(k)) {
      if (!best || n.length > best.len) best = { target, len: n.length };
    }
  }
  return best ? best.target : null;
}

// 把一季的分集转成 danmaku API 的 episode 结构
function toEpisodes(d) {
  return d.episodes.map((e) => ({
    episodeId: e.epId,
    episodeTitle: e.title,
    episodeNumber: String(e.index),
    url: `https://www.bilibili.com/bangumi/play/ep${e.epId}`,
  }));
}

function toAnime(d) {
  return {
    animeId: Number(d.seasonId) || 0,
    animeTitle: `${d.title}【${d.typeName || "B站"}】from bili`,
    type: mapType(d.typeName),
    typeDescription: d.typeName || "",
    episodes: toEpisodes(d),
  };
}

// 统一的 animes 构建：直通 → 映射表 → 关键词搜索
// detailTop: 只对前 N 个候选拉分集详情，控制一次请求的耗时（每个候选约 0.5s）
async function buildAnimes(keyword, { epNo = "", detailTop = 2 } = {}) {
  // ① 粘贴了链接 / ss / ep
  const direct = parseDirectTarget(keyword);
  if (direct) {
    try {
      const d = await getSeasonEpisodes(direct.id, direct.kind === "ep");
      if (d && d.episodes.length) return [toAnime(d)];
    } catch {
      // 落到下一步
    }
  }

  // ② 片名映射表
  const mapped = lookupMap(keyword);
  if (mapped) {
    const t = parseDirectTarget(mapped) || { kind: "ss", id: String(mapped).replace(/\D/g, "") };
    if (t.id) {
      try {
        const d = await getSeasonEpisodes(t.id, t.kind === "ep");
        if (d && d.episodes.length) return [toAnime(d)];
      } catch {
        // 落到下一步
      }
    }
  }

  // ③ 关键词搜索（机房 IP 下多半为空，返回空数组而不是报错）
  let list = await searchAll(keyword);
  if (list.length === 0 && keyword.length > 12) list = await searchAll(keyword.slice(0, 12));

  const animes = [];
  for (let i = 0; i < list.length && i < 5; i++) {
    const it = list[i];
    let d = null;
    if (i < detailTop) {
      try {
        d = await getSeasonEpisodes(it.seasonId);
      } catch {
        d = null;
      }
    }
    if (d && d.episodes.length) {
      animes.push(toAnime(d));
    } else {
      // 没拉详情时给空 episodes，客户端会再请求 /v2/bangumi/{animeId}
      animes.push({
        animeId: Number(it.seasonId) || 0,
        animeTitle: `${it.title}【${it.typeName || "B站"}】from bili`,
        type: mapType(it.typeName),
        typeDescription: it.typeName || "",
        episodes: [],
      });
    }
  }
  return animes;
}

// ---------- 直通：粘贴 B 站链接 / ss号 / ep号 直接命中 ----------
// 搜索接口被机房 IP 风控时，这是唯一稳定可用的入口。
// 用户在播放器搜索框里贴 https://www.bilibili.com/bangumi/play/ss218526 即可。
function parseDirectTarget(s) {
  const str = String(s || "").trim();
  let m;
  if ((m = str.match(/\bep(\d{4,})/i))) return { kind: "ep", id: m[1] };
  if ((m = str.match(/(?:ss|\/media\/md)(\d{2,})/i))) return { kind: "ss", id: m[1] };
  if (/^\d{2,8}$/.test(str)) return { kind: "ss", id: str };
  return null;
}

// ---------- 分集：pgc/view/web/season ----------
async function getSeasonEpisodes(seasonId, byEpId = false) {
  const param = byEpId ? `ep_id=${encodeURIComponent(seasonId)}` : `season_id=${encodeURIComponent(seasonId)}`;
  const { json } = await bjson(`https://api.bilibili.com/pgc/view/web/season?${param}`);
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
  "www.bilibili.com",
  "m.bilibili.com",
  "search.bilibili.com",
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

// 逐个入口单测：返回每个入口的原始结果，用于定位是哪个入口在污染关键词
async function handleProbe2(res, keyword) {
  const out = {};
  const t = async (name, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      out[name] = {
        ms: Date.now() - t0,
        n: Array.isArray(r) ? r.length : null,
        titles: (Array.isArray(r) ? r : []).slice(0, 6).map((x) => x.title),
        ids: (Array.isArray(r) ? r : []).slice(0, 6).map((x) => x.seasonId),
      };
    } catch (e) {
      out[name] = { ms: Date.now() - t0, error: (e && e.message) || String(e) };
    }
  };

  const mixin = await getMixinKey();
  out._mixinKey = mixin ? mixin.slice(0, 8) + "…(len " + mixin.length + ")" : "FAILED";

  await t("web_media_ft", () => viaWebSearch(keyword, "media_ft"));
  await t("web_media_ft_cookie", () => viaWebSearch(keyword, "media_ft", true));
  await t("web_media_bangumi", () => viaWebSearch(keyword, "media_bangumi"));
  await t("web_bangumi_cookie", () => viaWebSearch(keyword, "media_bangumi", true));
  await t("alt", () => viaAltSearch(keyword));
  await t("html", () => viaHtmlSearch(keyword));
  await t("pgc_index", () => viaPgcIndex(keyword));
  await t("app", () => viaAppSearch(keyword));
  await t("pgc", () => viaPgcSearch(keyword));
  out._hasCookie = !!(process.env.BILIBILI_COOKIE && process.env.BILIBILI_COOKIE.length > 20);

  // 原始返回，不经解析，用来判断接口本身给的是不是空
  const raw = {};
  try {
    const s = await signedWbi({ keyword, search_type: "media_ft" });
    const { status, buf } = await bfetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${s}`);
    const j = JSON.parse(buf.toString("utf8"));
    raw.wbi_search_media_ft = {
      status,
      code: j.code,
      message: j.message,
      numResults: j.data && j.data.numResults,
      resultLen: j.data && j.data.result ? j.data.result.length : null,
      signedParams: s ? s.slice(0, 90) : null,
    };
  } catch (e) {
    raw.wbi_search_media_ft = { error: (e && e.message) || String(e) };
  }

  return send(res, 200, { keyword, entries: out, raw });
}

// HTML 搜索页诊断：确认页面是否真的含 season_id，还是被拦成空壳/验证页
async function handleProbe3(res, keyword) {
  const out = {};
  const cookie = process.env.BILIBILI_COOKIE || "";
  const headers = { Accept: "text/html,application/xhtml+xml" };
  if (cookie) {
    const keep = cookie.split(";").map((x) => x.trim())
      .filter((x) => /^(SESSDATA|bili_jct|DedeUserID|buvid3|buvid4)=/.test(x));
    if (keep.length) headers.Cookie = keep.join("; ");
  }
  const targets = [
    `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
    `https://search.bilibili.com/media?keyword=${encodeURIComponent(keyword)}`,
    `https://m.bilibili.com/search?keyword=${encodeURIComponent(keyword)}`,
    `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}&t=media`,
    `https://api.bilibili.com/x/web-interface/search/type?search_type=media_ft&keyword=${encodeURIComponent(keyword)}`,
  ];
  for (const u of targets) {
    const t0 = Date.now();
    try {
      const { buf, status } = await bfetch(u, { headers, timeout: 12000 });
      const html = buf.toString("utf8");
      out[u] = {
        status,
        ms: Date.now() - t0,
        bytes: html.length,
        seasonIdHits: (html.match(/season_id/g) || []).length,
        ssHits: (html.match(/\/bangumi\/play\/ss\d+/g) || []).length,
        mdHits: (html.match(/\/bangumi\/media\/md\d+/g) || []).length,
        hasInitialState: html.includes("__INITIAL_STATE__"),
        hasVerify: /验证|verify|captcha|安全中心/i.test(html.slice(0, 3000)),
        head: html.slice(0, 240).replace(/\s+/g, " "),
        // 把 season_id / 作品 ID 出现处的上下文摘出来，用来判断 SSR 数据结构
        contexts: (() => {
          const arr = [];
          const re = /season_id|"ssid"|bangumi|media_id/g;
          let m;
          let n = 0;
          while ((m = re.exec(html)) && n < 5) {
            arr.push(html.slice(Math.max(0, m.index - 120), m.index + 200).replace(/\s+/g, " "));
            n++;
          }
          return arr;
        })(),
        titleHits: (html.match(/蜘蛛侠/g) || []).length,
      };
    } catch (e) {
      out[u] = { error: (e && e.message) || String(e) };
    }
  }
  return send(res, 200, { keyword, out });
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
  if (path === "/bili/_probe2" || path === "/_probe2") {
    return handleProbe2(res, sp.get("keyword") || "");
  }
  if (path === "/bili/_probe3" || path === "/_probe3") {
    return handleProbe3(res, sp.get("keyword") || "");
  }

  // 剥前缀
  if (path.startsWith("/bili")) path = path.slice(5);
  if (!path.startsWith("/")) path = "/" + path;
  if (path.startsWith("/api/")) path = path.slice(4);

  // 健康检查
  if (path === "/" || path === "") {
    return send(res, 200, {
      service: "danmu_api bili mount",
      note: "B 站独立源。机房 IP 的搜索接口被 B 站服务端置零，所以支持直接粘贴 ss/ep 号或链接；片名可用 bili-map.js 预先登记",
      selfTest: "/bili/api/v2/search/anime?keyword=ss218526",
      probe: "/bili/_probe?u=<urlencoded bilibili api url>",
    });
  }

  // ---- 搜索：anime 列表 ----
  // 客户端（Hills / 各类 danmaku API 播放器）搜索第一步走这里，
  // 之前只实现了 search/episodes，搜索框一按就 404。
  if (path === "/v2/search/anime" || path === "/v2/search/episodes") {
    const isAnime = path === "/v2/search/anime";
    const keyword = ((isAnime ? sp.get("keyword") : sp.get("anime")) || "").trim();
    const epNo = isAnime ? "" : sp.get("episode") || "";
    if (!keyword) {
      return send(res, 200, {
        success: false,
        errorCode: 400,
        errorMessage: isAnime ? "keyword required" : "anime required",
        animes: [],
      });
    }
    try {
      // search/anime 只要作品级信息，最多拉 1 个详情；search/episodes 要集列表，拉 2 个
      const animes = await buildAnimes(keyword, { epNo, detailTop: isAnime ? 1 : 2 });
      // episode 参数存在时，把每条里的集列表收窄到那一集
      if (epNo) {
        for (const a of animes) {
          if (!a.episodes.length) continue;
          const hit = a.episodes.filter(
            (e) => String(e.episodeNumber) === String(epNo) || String(e.episodeTitle).includes(String(epNo))
          );
          if (hit.length) a.episodes = hit;
        }
      }
      return send(
        res,
        200,
        { success: true, errorCode: 0, errorMessage: "", animes },
        ttlFor("/v2/search/")
      );
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
            type: mapType(d.typeName),
            typeDescription: d.typeName,
            episodes: toEpisodes(d),
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
