/**
 * 갬투자 서버 — Railway/Render 클라우드 배포용
 * 토큰은 절대 여기 넣지 말고 환경변수(Railway Variables)에만 설정!
 */

const express = require("express");
const cors    = require("cors");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;   // Railway가 PORT를 자동 주입

// ── 환경변수에서 읽기 (코드에 절대 하드코딩 X) ──
const NOTION_TOKEN  = process.env.NOTION_TOKEN  || "";
const NOTION_DB_ID  = process.env.NOTION_DB_ID  || "a714ebff-e26e-4f8d-9b7b-f9873f549a9b";
const DART_API_KEY  = process.env.DART_API_KEY  || "";

// ── CORS: Netlify 도메인 + 로컬 모두 허용 ──
const ALLOWED = [
  /netlify\.app$/,          // *.netlify.app
  /localhost/,              // 로컬 개발
  /127\.0\.0\.1/,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.some(r => r.test(origin))) cb(null, true);
    else cb(new Error("CORS 차단: " + origin));
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
}));
app.use(express.json());

// ── HTTPS 헬퍼 ──
function req(options, body = null) {
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
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ── 유틸: Notion 공통 헤더 ──
const notionHeaders = () => ({
  Authorization: `Bearer ${NOTION_TOKEN}`,
  "Content-Type": "application/json",
  "Notion-Version": "2022-06-28",
});

// ────────────────────────────────────────
// GET /api/ping  — 헬스체크 (Railway 모니터링용)
// ────────────────────────────────────────
app.get("/api/ping", (_, res) => {
  res.json({
    ok: true,
    env: {
      notion: NOTION_TOKEN ? "✅ 설정됨" : "❌ 미설정",
      dart:   DART_API_KEY ? "✅ 설정됨" : "⚠️ 미설정(선택)",
    },
    time: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
  });
});

// ────────────────────────────────────────
// GET /api/tasks  — 작업 목록 조회
// ────────────────────────────────────────
app.get("/api/tasks", async (_, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN 환경변수가 없습니다" });

  try {
    const r = await req({
      hostname: "api.notion.com",
      path: `/v1/databases/${NOTION_DB_ID}/query`,
      method: "POST",
      headers: notionHeaders(),
    }, {
      sorts: [{ property: "마감일", direction: "ascending" }],
    });

    if (r.status !== 200) return res.status(r.status).json({ error: "Notion 오류", detail: r.data });

    const tasks = r.data.results.map(page => {
      const p = page.properties;
      return {
        id:      page.id,
        url:     page.url,
        작업명:  p["작업명"]?.title?.[0]?.plain_text   || "",
        상태:    p["상태"]?.select?.name               || "",
        우선순위: p["우선순위"]?.select?.name          || "",
        카테고리: p["카테고리"]?.select?.name          || "",
        마감일:  p["마감일"]?.date?.start              || "",
        담당자:  p["담당자"]?.rich_text?.[0]?.plain_text || "",
        메모:    p["메모"]?.rich_text?.[0]?.plain_text  || "",
        완료여부: p["완료여부"]?.checkbox               || false,
      };
    });

    res.json({ tasks, total: tasks.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────
// PATCH /api/tasks/:id  — 상태 변경
// ────────────────────────────────────────
app.patch("/api/tasks/:id", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN 환경변수가 없습니다" });

  const updates = {};
  if (req.body.상태)              updates["상태"]    = { select: { name: req.body.상태 } };
  if (req.body.완료여부 != null)  updates["완료여부"] = { checkbox: req.body.완료여부 };
  if (req.body.메모)              updates["메모"]    = { rich_text: [{ type: "text", text: { content: req.body.메모 } }] };

  try {
    const r = await req({
      hostname: "api.notion.com",
      path: `/v1/pages/${req.params.id}`,
      method: "PATCH",
      headers: notionHeaders(),
    }, { properties: updates });

    res.json({ success: r.status === 200 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────
// POST /api/tasks  — 새 작업 추가
// ────────────────────────────────────────
app.post("/api/tasks", async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN 환경변수가 없습니다" });

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
    const r = await req({
      hostname: "api.notion.com",
      path: "/v1/pages",
      method: "POST",
      headers: notionHeaders(),
    }, { parent: { database_id: NOTION_DB_ID }, properties });

    res.json({ success: r.status === 200, id: r.data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────
// GET /api/dart/:corpCode  — 전자공시 (선택)
// ────────────────────────────────────────
app.get("/api/dart/:corpCode", async (req, res) => {
  if (!DART_API_KEY) return res.json({ message: "DART_API_KEY 미설정 (선택 기능)", data: [] });

  try {
    const r = await req({
      hostname: "opendart.fss.or.kr",
      path: `/api/list.json?crtfc_key=${DART_API_KEY}&corp_code=${req.params.corpCode}&pblntf_ty=${req.query.type || "A001"}&bgn_de=20240101`,
      method: "GET",
    });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 갬투자 서버 시작 — PORT ${PORT}`);
  console.log(`   Notion: ${NOTION_TOKEN ? "✅" : "❌ NOTION_TOKEN 없음"}`);
  console.log(`   DART:   ${DART_API_KEY ? "✅" : "⚠️  미설정(선택)"}`);
});
