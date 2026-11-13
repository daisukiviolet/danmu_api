// danmu_api/bili-fix.js
// /bili/* 的响应整形层，位置在 bili.js 之外，不参与搜索逻辑。
//
// 为什么需要它
// 弹弹play 官方 /v2/search/anime 的每条作品里没有 episodes 数组，
// 只有 episodeCount（整数）。客户端搜索面板就是读这个字段渲染「共 N 集」。
// bili.js 只塞了 episodes、没给 episodeCount，客户端算出来是 0 集：
// 条目能显示、标题正常，但集数为 0，点进去也没有分集。
//
// 这里在响应出口补字段，bili.js 本体不动 —— 那边还在迭代搜索入口，
// 两层分开改，互不干扰。
//
// 只处理 /v2/search/* 与 /v2/bangumi/* 的 JSON；弹幕接口原样透传，
// 不做 parse/stringify（几千条弹幕来回序列化没必要，也怕精度被动到）。

import bili from "./bili.js";

// 把一条作品补齐成官方结构
function shapeOne(a) {
  if (!a || typeof a !== "object") return a;
  if (!Array.isArray(a.episodes)) a.episodes = [];

  // episodes 有内容就以它为准；只有 stub（未拉详情）时才沿用搜索入口给的 epSize
  const fromEps = a.episodes.length;
  const existing = Number(a.episodeCount) || 0;
  const n = fromEps || existing;
  a.episodeCount = n;

  if (!Array.isArray(a.seasons) || a.seasons.length === 0) {
    a.seasons = n
      ? [{ id: `season-${a.animeId}`, airDate: "", name: "Season 1", episodeCount: n }]
      : [];
  } else {
    for (const s of a.seasons) if (!s.episodeCount) s.episodeCount = n;
  }

  if (!a.bangumiId && a.animeId) a.bangumiId = `ss${a.animeId}`;
  if (a.imageUrl === undefined) a.imageUrl = "";
  if (a.startDate === undefined) a.startDate = "";
  if (a.rating === undefined) a.rating = 0;
  if (a.isFavorited === undefined) a.isFavorited = false;
  if (a.source === undefined) a.source = "bili";
  if (!Array.isArray(a.aliases)) a.aliases = [];
  if (a.typeDescription === undefined) a.typeDescription = "";

  // 分集里也补上 episodeCount 依赖的字段，客户端有的版本会逐条校验
  for (const e of a.episodes) {
    if (e && typeof e === "object") {
      if (e.episodeId !== undefined && typeof e.episodeId !== "number") {
        const v = Number(e.episodeId);
        if (Number.isFinite(v)) e.episodeId = v;
      }
      if (e.episodeNumber !== undefined && typeof e.episodeNumber !== "string") {
        e.episodeNumber = String(e.episodeNumber);
      }
    }
  }
  return a;
}

function shapeBody(j) {
  if (!j || typeof j !== "object") return j;
  if (Array.isArray(j.animes)) j.animes = j.animes.map(shapeOne);
  if (j.bangumi) j.bangumi = shapeOne(j.bangumi);
  return j;
}

export default async function handler(req, res) {
  const url = String(req.url || "");
  // 只有搜索与详情需要整形；comment / _probe / 健康检查全部直通
  if (!/\/v2\/(search|bangumi)(\/|\?|$)/i.test(url)) return bili(req, res);

  // bili.js 统一走 send() → res.end(JSON.stringify)，这里拦一次出口改字段，
  // 比复制一份路由逻辑安全：那边改搜索入口时不会被这边覆盖掉。
  const origEnd = res.end.bind(res);
  res.end = function (chunk, encoding, cb) {
    try {
      const ct = String(res.getHeader("content-type") || "");
      if (chunk && ct.includes("application/json")) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const body = JSON.stringify(shapeBody(JSON.parse(text)));
        const out = Buffer.from(body, "utf8");
        // 必须同步 content-length，否则客户端按旧长度截断
        res.setHeader("content-length", Buffer.byteLength(body));
        return origEnd(out, encoding, cb);
      }
    } catch {
      // 解析失败按原样返回，不能因为整形把正常响应吃掉
    }
    return origEnd(chunk, encoding, cb);
  };

  return bili(req, res);
}
