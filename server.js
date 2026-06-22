/**
 * 갬투자 서버 v2.0 — Render 클라우드 배포용
 * 환경변수에만 키 설정! 코드에 절대 하드코딩 X
 *
 * Render Environment Variables:
 *   NOTION_TOKEN      - Notion 개인 액세스 토큰
 *   NOTION_DB_ID      - 갬투자 작업 DB ID
 *   KIS_APP_KEY       - 한국투자증권 App Key
 *   KIS_APP_SECRET    - 한국투자증권 App Secret
 *   KIS_ACCOUNT_NO    - 계좌번호 앞 8자리 (선택, 잔고조회용)
 *   KIS_ACCOUNT_TYPE  - 계좌종류 (01=일반, 선택)
 *   DART_API_KEY      - DART 전자공시 API 키 (선택)
 */

const express = require("express");
const cors    = require("cors");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 환경변수 ──
const NOTION_TOKEN   = process.env.NOTION_TOKEN  || "";
const NOTION_DB_ID   = process.env.NOTION_DB_ID  || "a714ebff-e26e-4f8d-9b7b-f9873f549a9b";
const KIS_APP_KEY    = process.env.KIS_APP_KEY    || "";
const KIS_APP_SECRET = process.env.KIS_APP_SECRET || "";
const KIS_ACCOUNT_NO = process.env.KIS_ACCOUNT_NO || "";
const KIS_ACCT_TYPE  = process.env.KIS_ACCOUNT_TYPE || "01";
const DART_API_KEY   = process.env.DART_API_KEY   || "";

// ── KIS 토큰 캐시 (만료 전까지 재사용) ──
let kisToken = null;
let kisTokenExpiry = 0;

// ── CORS ──
const ALLOWED = [/netlify\.app$/, /localhost/, /127\.0\.0\.1/, /onrender\.com$/];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.some(r => r.test(origin))) cb(null, true);
    else cb(new Error("CORS 차단: " + origin));
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
}));
app.use(express.json());

// ════════════════════════════════════════════════
// 공통 유틸
// ════════════════════════════════════════════════

function httpsReq(options, body = null) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    r.on("error", reject);
    if (body) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}

const notionHeaders = () => ({
  Authorization: `Bearer ${NOTION_TOKEN}`,
  "Content-Type": "application/json",
  "Notion-Version": "2022-06-28",
});

// ════════════════════════════════════════════════
// KIS API 유틸
// ════════════════════════════════════════════════

// KIS OAuth 토큰 발급 (24시간 유효, 캐시해서 재사용)
async function getKisToken() {
  const now = Date.now();
  if (kisToken && now < kisTokenExpiry) return kisToken;

  if (!KIS_APP_KEY || !KIS_APP_SECRET) {
    throw new Error("KIS_APP_KEY 또는 KIS_APP_SECRET 환경변수가 없습니다");
  }

  const body = JSON.stringify({
    grant_type: "client_credentials",
    appkey: KIS_APP_KEY,
    appsecret: KIS_APP_SECRET,
  });

  const result = await httpsReq({
    hostname: "openapi.koreainvestment.com",
    port: 9443,
    path: "/oauth2/tokenP",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);

  if (result.status !== 200 || !result.data.access_token) {
    throw new Error("KIS 토큰 발급 실패: " + JSON.stringify(result.data));
  }

  kisToken = result.data.access_token;
  // 만료 23시간 후로 설정 (여유 1시간)
  kisTokenExpiry = now + 23 * 60 * 60 * 1000;
  console.log("✅ KIS 토큰 발급 완료");
  return kisToken;
}

// KIS REST API 공통 호출
async function kisGet(path, trId, params = {}) {
  const token = await getKisToken();
  const query = new URLSearchParams(params).toString();
  const fullPath = query ? `${path}?${query}` : path;

  return httpsReq({
    hostname: "openapi.koreainvestment.com",
    port: 9443,
    path: fullPath,
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: trId,
      custtype: "P",
    },
  });
}

// ════════════════════════════════════════════════
// GET /api/ping — 헬스체크
// ════════════════════════════════════════════════
app.get("/api/ping", (_, res) => {
  res.json({
    ok: true,
    env: {
      notion: NOTION_TOKEN   ? "✅ 설정됨" : "❌ 미설정",
      kis:    KIS_APP_KEY    ? "✅ 설정됨" : "❌ 미설정",
      dart:   DART_API_KEY   ? "✅ 설정됨" : "⚠️ 미설정(선택)",
    },
    kisTokenCached: !!kisToken && Date.now() < kisTokenExpiry,
    time: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
  });
});

// ════════════════════════════════════════════════
// KIS 시세 API
// ════════════════════════════════════════════════

// GET /api/stock/:code — 주식 현재가 단건 조회
// 예: /api/stock/005930
app.get("/api/stock/:code", async (req, res) => {
  if (!KIS_APP_KEY) return res.status(500).json({ error: "KIS_APP_KEY 환경변수가 없습니다" });

  try {
    const r = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-price",
      "FHKST01010100",
      { fid_cond_mrkt_div_code: "J", fid_input_iscd: req.params.code }
    );

    if (r.status !== 200 || r.data.rt_cd !== "0") {
      return res.status(400).json({ error: "KIS 조회 실패", detail: r.data });
    }

    const d = r.data.output;
    res.json({
      code:   req.params.code,
      name:   d.hts_kor_isnm,          // 종목명
      price:  parseInt(d.stck_prpr),    // 현재가
      change: parseInt(d.prdy_vrss),    // 전일대비
      changePct: parseFloat(d.prdy_ctrt), // 등락률
      open:   parseInt(d.stck_oprc),    // 시가
      high:   parseInt(d.stck_hgpr),    // 고가
      low:    parseInt(d.stck_lwpr),    // 저가
      volume: parseInt(d.acml_vol),     // 누적거래량
      tradeAmt: parseInt(d.acml_tr_pbm), // 거래대금
      marketCap: d.hts_avls,            // 시가총액
      per:    d.per,                    // PER
      pbr:    d.pbr,                    // PBR
      eps:    d.eps,                    // EPS
      w52High: parseInt(d.d250_hgpr),   // 52주 최고
      w52Low:  parseInt(d.d250_lwpr),   // 52주 최저
    });
  } catch (e) {
    console.error("stock error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stocks — 여러 종목 현재가 일괄 조회
// 예: /api/stocks?codes=005930,000660,015760
app.get("/api/stocks", async (req, res) => {
  if (!KIS_APP_KEY) return res.status(500).json({ error: "KIS_APP_KEY 환경변수가 없습니다" });

  const codes = (req.query.codes || "").split(",").filter(Boolean).slice(0, 20);
  if (!codes.length) return res.status(400).json({ error: "codes 파라미터가 필요합니다" });

  try {
    // 병렬로 조회 (KIS는 단건 조회만 지원)
    const results = await Promise.allSettled(
      codes.map(code =>
        kisGet(
          "/uapi/domestic-stock/v1/quotations/inquire-price",
          "FHKST01010100",
          { fid_cond_mrkt_div_code: "J", fid_input_iscd: code.trim() }
        )
      )
    );

    const stocks = results.map((r, i) => {
      if (r.status === "rejected" || r.value.data?.rt_cd !== "0") {
        return { code: codes[i], error: true };
      }
      const d = r.value.data.output;
      return {
        code:      codes[i],
        name:      d.hts_kor_isnm,
        price:     parseInt(d.stck_prpr),
        change:    parseInt(d.prdy_vrss),
        changePct: parseFloat(d.prdy_ctrt),
        volume:    parseInt(d.acml_vol),
        high:      parseInt(d.stck_hgpr),
        low:       parseInt(d.stck_lwpr),
      };
    });

    res.json({ stocks, count: stocks.length, time: new Date().toISOString() });
  } catch (e) {
    console.error("stocks error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stock/:code/chart — 일봉 차트 데이터
// 예: /api/stock/005930/chart?period=D (D=일, W=주, M=월)
app.get("/api/stock/:code/chart", async (req, res) => {
  if (!KIS_APP_KEY) return res.status(500).json({ error: "KIS_APP_KEY 미설정" });

  const period = req.query.period || "D";
  const today  = new Date().toISOString().slice(0,10).replace(/-/g,"");
  const from   = req.query.from || (() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0,10).replace(/-/g,"");
  })();

  try {
    const r = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      "FHKST03010100",
      {
        fid_cond_mrkt_div_code: "J",
        fid_input_iscd:         req.params.code,
        fid_input_date_1:       from,
        fid_input_date_2:       today,
        fid_period_div_code:    period,
        fid_org_adj_prc:        "0",
      }
    );

    if (r.status !== 200) return res.status(400).json({ error: "차트 조회 실패" });

    const candles = (r.data.output2 || []).map(d => ({
      date:   d.stck_bsop_date,
      open:   parseInt(d.stck_oprc),
      high:   parseInt(d.stck_hgpr),
      low:    parseInt(d.stck_lwpr),
      close:  parseInt(d.stck_clpr),
      volume: parseInt(d.acml_vol),
    })).reverse(); // 오래된 것부터 정렬

    res.json({ code: req.params.code, period, candles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stock/:code/orderbook — 호가 조회
app.get("/api/stock/:code/orderbook", async (req, res) => {
  if (!KIS_APP_KEY) return res.status(500).json({ error: "KIS_APP_KEY 미설정" });

  try {
    const r = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
      "FHKST01010200",
      { fid_cond_mrkt_div_code: "J", fid_input_iscd: req.params.code }
    );

    if (r.status !== 200) return res.status(400).json({ error: "호가 조회 실패" });

    const d = r.data.output1;
    const asks = [], bids = [];
    for (let i = 1; i <= 10; i++) {
      asks.push({ price: parseInt(d[`askp${i}`]),  qty: parseInt(d[`askp_rsqn${i}`]) });
      bids.push({ price: parseInt(d[`bidp${i}`]),  qty: parseInt(d[`bidp_rsqn${i}`]) });
    }
    res.json({ code: req.params.code, asks, bids });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/top — 상승률/거래량 상위 종목
// 예: /api/market/top?type=rise (rise=상승률, fall=하락률, volume=거래량)
app.get("/api/market/top", async (req, res) => {
  if (!KIS_APP_KEY) return res.status(500).json({ error: "KIS_APP_KEY 미설정" });

  const typeMap = {
    rise:   { trId: "FHPST01700000", sortCode: "1" }, // 상승률
    fall:   { trId: "FHPST01700000", sortCode: "2" }, // 하락률
    volume: { trId: "FHPST01700000", sortCode: "4" }, // 거래량
  };
  const { trId, sortCode } = typeMap[req.query.type || "rise"];

  try {
    const r = await kisGet(
      "/uapi/domestic-stock/v1/ranking/fluctuation",
      trId,
      {
        fid_cond_mrkt_div_code: "J",
        fid_cond_scr_div_code:  "20170",
        fid_input_iscd:         "0000",
        fid_rank_sort_cls_code: sortCode,
        fid_input_cnt_1:        "0",
        fid_prc_cls_code:       "1",
        fid_input_price_1:      "",
        fid_input_price_2:      "",
        fid_vol_cnt:            "",
        fid_trgt_cls_code:      "0",
        fid_trgt_exls_cls_code: "0",
        fid_div_cls_code:       "0",
        fid_rsfl_rate1:         "",
        fid_rsfl_rate2:         "",
      }
    );

    if (r.status !== 200) return res.status(400).json({ error: "상위종목 조회 실패" });

    const stocks = (r.data.output || []).slice(0, 20).map(d => ({
      rank:      d.data_rank,
      code:      d.stck_shrn_iscd,
      name:      d.hts_kor_isnm,
      price:     parseInt(d.stck_prpr),
      changePct: parseFloat(d.prdy_ctrt),
      volume:    parseInt(d.acml_vol),
    }));

    res.json({ type: req.query.type || "rise", stocks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// Notion 작업 API
// ════════════════════════════════════════════════

app.get("/api/tasks", async (_, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN 환경변수가 없습니다" });
  try {
    const r = await httpsReq({
      hostname: "api.notion.com",
      path: `/v1/databases/${NOTION_DB_ID}/query`,
      method: "POST",
      headers: notionHeaders(),
    }, { sorts: [{ property: "마감일", direction: "ascending" }] });

    if (r.status !== 200) return res.status(r.status).json({ error: "Notion 오류", detail: r.data });

    const tasks = r.data.results.map(page => {
      const p = page.properties;
      return {
        id:       page.id,
        url:      page.url,
        작업명:   p["작업명"]?.title?.[0]?.plain_text    || "",
        상태:     p["상태"]?.select?.name                || "",
        우선순위: p["우선순위"]?.select?.name            || "",
        카테고리: p["카테고리"]?.select?.name            || "",
        마감일:   p["마감일"]?.date?.start               || "",
        담당자:   p["담당자"]?.rich_text?.[0]?.plain_text || "",
        메모:     p["메모"]?.rich_text?.[0]?.plain_text   || "",
        완료여부: p["완료여부"]?.checkbox                 || false,
      };
    });
    res.json({ tasks, total: tasks.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/tasks/:id", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN 없음" });
  const updates = {};
  if (req.body.상태)             updates["상태"]    = { select: { name: req.body.상태 } };
  if (req.body.완료여부 != null) updates["완료여부"] = { checkbox: req.body.완료여부 };
  if (req.body.메모)             updates["메모"]    = { rich_text: [{ type: "text", text: { content: req.body.메모 } }] };
  try {
    const r = await httpsReq({
      hostname: "api.notion.com",
      path: `/v1/pages/${req.params.id}`,
      method: "PATCH",
      headers: notionHeaders(),
    }, { properties: updates });
    res.json({ success: r.status === 200 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/tasks", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN 없음" });
  const { 작업명, 상태 = "할 일", 우선순위 = "보통", 카테고리 = "기획", 마감일, 메모 } = req.body;
  if (!작업명) return res.status(400).json({ error: "작업명은 필수입니다" });
  const properties = {
    작업명:   { title: [{ text: { content: 작업명 } }] },
    상태:     { select: { name: 상태 } },
    우선순위: { select: { name: 우선순위 } },
    카테고리: { select: { name: 카테고리 } },
    완료여부: { checkbox: false },
  };
  if (마감일) properties["마감일"] = { date: { start: 마감일 } };
  if (메모)   properties["메모"]   = { rich_text: [{ type: "text", text: { content: 메모 } }] };
  try {
    const r = await httpsReq({
      hostname: "api.notion.com",
      path: "/v1/pages",
      method: "POST",
      headers: notionHeaders(),
    }, { parent: { database_id: NOTION_DB_ID }, properties });
    res.json({ success: r.status === 200, id: r.data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// DART 전자공시
// ════════════════════════════════════════════════
app.get("/api/dart/:corpCode", async (req, res) => {
  if (!DART_API_KEY) return res.json({ message: "DART_API_KEY 미설정", data: [] });
  try {
    const r = await httpsReq({
      hostname: "opendart.fss.or.kr",
      path: `/api/list.json?crtfc_key=${DART_API_KEY}&corp_code=${req.params.corpCode}&pblntf_ty=${req.query.type || "A001"}&bgn_de=20240101`,
      method: "GET",
    });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// 서버 시작
// ════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`\n🚀 갬투자 서버 v2.0 — PORT ${PORT}`);
  console.log(`   Notion : ${NOTION_TOKEN   ? "✅" : "❌ 미설정"}`);
  console.log(`   KIS    : ${KIS_APP_KEY    ? "✅" : "❌ 미설정"}`);
  console.log(`   DART   : ${DART_API_KEY   ? "✅" : "⚠️  선택"}`);
  console.log(`\n📡 API 엔드포인트:`);
  console.log(`   GET  /api/ping`);
  console.log(`   GET  /api/stock/:code          현재가`);
  console.log(`   GET  /api/stocks?codes=A,B,C   일괄조회`);
  console.log(`   GET  /api/stock/:code/chart    일봉차트`);
  console.log(`   GET  /api/stock/:code/orderbook 호가`);
  console.log(`   GET  /api/market/top?type=rise  상위종목`);
  console.log(`   GET  /api/tasks                Notion 작업\n`);

  // 서버 시작 시 KIS 토큰 미리 발급
  if (KIS_APP_KEY) {
    try { await getKisToken(); }
    catch (e) { console.error("⚠️  KIS 토큰 초기화 실패:", e.message); }
  }
});
