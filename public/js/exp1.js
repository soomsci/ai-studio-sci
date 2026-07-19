// js/exp1.js — 실험 1 "우리 교실 최적 환기 주기 찾기" 탭 (세션 B)
//
// 화면 구성 (위 → 아래):
//   ① 탐구 질문 헤더
//   ② 우리 모둠 측정 목록 + 연습 데이터 만들기 + 분석에 쓸 측정 고르기
//   ③ 분석 5단계 (steps.js의 renderSteps) — 그래프·자동 계산은 render 훅으로 끼움
//
// 문구·질문·그래프 설정은 전부 config/exp1.config.js에 있다.

import { EXP1 } from "../config/exp1.config.js";
import { listDatasets, saveDataset, getAnalysis, saveAnalysis } from "./data.js";
import { renderChart } from "./chart-kit.js";
import { renderSteps } from "./steps.js";
import { getSession } from "./auth.js";

// 탭이 열려 있는 동안의 상태 (탭을 다시 열면 mount가 새로 채운다)
let rootEl = null;    // 탭 컨테이너
let session = null;   // { groupId, groupName, ... }
let datasets = [];    // 우리 모둠 측정 목록
let analysis = null;  // 우리 모둠 분석 문서 (getAnalysis 결과)
let slots = {};       // 단계별 render 훅이 그린 자리 — 측정 선택이 바뀌면 다시 그린다

// ── 탭 진입점 (router.js 규약) ─────────────────────────────
export async function mount(containerEl) {
  rootEl = containerEl;
  session = getSession();
  slots = {};
  injectStyle();

  containerEl.innerHTML = `
    <section class="exp1-header">
      <h2>💨 실험 1 — ${EXP1.title}</h2>
      <p class="exp1-question">탐구 질문: <strong>${EXP1.question}</strong></p>
    </section>

    <section class="exp1-box">
      <h3>우리 모둠의 측정</h3>
      <p class="exp1-help">분석에 쓸 측정을 골라 주세요. 여러 개를 고르면 그래프에 겹쳐 그려져요.</p>
      <div id="exp1-list"><p class="exp1-dim">측정 목록을 불러오는 중…</p></div>
      <div class="exp1-practice">
        <label>아직 센서가 없다면 —
          <select id="exp1-cond">
            ${EXP1.conditions.map((c) => `<option>${c}</option>`).join("")}
          </select>
        </label>
        <button id="exp1-make">연습 데이터 만들기</button>
        <span id="exp1-make-msg" class="exp1-dim"></span>
      </div>
    </section>

    <section id="exp1-steps"></section>
  `;

  containerEl.querySelector("#exp1-make").addEventListener("click", onMakePractice);
  await reload();
}

// 측정 목록과 분석 문서를 불러와 화면을 채운다
async function reload() {
  [datasets, analysis] = await Promise.all([
    listDatasets(EXP1.expNo, session.groupId),
    getAnalysis(EXP1.expNo, session.groupId),
  ]);
  analysis.expNo = EXP1.expNo;
  analysis.groupId = session.groupId;
  analysis.chartOptions = analysis.chartOptions || { chartType: "line", showRef: true };
  analysis.chartType = analysis.chartOptions.chartType;

  // 지워진 측정은 선택에서 빼고, 아무것도 안 골랐으면 전부 고른 것으로 시작한다
  const ids = datasets.map((d) => d.id);
  let picked = (analysis.datasetIds || []).filter((id) => ids.includes(id));
  if (!picked.length) picked = [...ids];
  analysis.datasetIds = picked;

  renderDatasetList(rootEl.querySelector("#exp1-list"));
  renderSteps(rootEl.querySelector("#exp1-steps"), buildSteps(), analysis, saveAnalysis);
}

// 지금 분석에 골라 둔 측정들
function pickedDatasets() {
  return datasets.filter((d) => analysis.datasetIds.includes(d.id));
}

// ── ② 측정 목록 (체크박스) ────────────────────────────────
function renderDatasetList(listEl) {
  if (!datasets.length) {
    listEl.innerHTML = `<p class="exp1-dim">아직 측정이 없어요. 아래에서 연습 데이터를 만들어 보세요.</p>`;
    return;
  }
  listEl.innerHTML = datasets
    .map((d) => {
      const mins = Math.round((d.points.at(-1)?.t || 0) / 60);
      const checked = analysis.datasetIds.includes(d.id) ? "checked" : "";
      return `<label class="exp1-item">
        <input type="checkbox" data-id="${d.id}" ${checked}>
        <b>${d.title}</b>
        <span class="exp1-dim">${d.condition} · ${mins}분 · ${d.points.length}개 점${d.source === "mock" ? " · 연습" : ""}</span>
      </label>`;
    })
    .join("");

  listEl.querySelectorAll("input[type=checkbox]").forEach((box) => {
    box.addEventListener("change", () => {
      const id = box.dataset.id;
      analysis.datasetIds = box.checked
        ? [...analysis.datasetIds, id]
        : analysis.datasetIds.filter((x) => x !== id);
      saveAnalysis(analysis);
      refreshSlots(); // 열려 있는 단계의 그래프·표를 새로 그린다
    });
  });
}

// "연습 데이터 만들기" — generateMock으로 가짜 측정을 만들어 저장한다.
// mock/ 폴더는 배포에 포함되지 않을 수 있어 동적 import + 실패 안내로 감싼다.
async function onMakePractice() {
  const msgEl = rootEl.querySelector("#exp1-make-msg");
  const cond = rootEl.querySelector("#exp1-cond").value;
  try {
    msgEl.textContent = "만드는 중…";
    const { generateMock } = await import("../mock/mock-data.js");
    const ds = generateMock(EXP1.expNo, cond);
    ds.groupId = session.groupId;
    await saveDataset(ds);
    msgEl.textContent = "";
    await reload();
  } catch (e) {
    console.error(e);
    msgEl.textContent = "연습 데이터를 만들지 못했어요. 선생님께 알려 주세요.";
  }
}

// ── ③ 분석 5단계 — config의 steps에 render 훅을 끼운다 ────
function buildSteps() {
  const hooks = { s1: renderStep1Info, s2: renderStep2Chart, s3: renderStep3Chart };
  return EXP1.steps.map((step) => {
    const hook = hooks[step.id];
    if (!hook) return step; // 4·5단계는 글로만 답한다
    return {
      ...step,
      render: (slotEl) => {
        slots[step.id] = slotEl;
        hook(slotEl);
      },
    };
  });
}

// 측정 선택이 바뀌었을 때, 이미 그려져 있는 단계 내용을 다시 그린다
function refreshSlots() {
  const hooks = { s1: renderStep1Info, s2: renderStep2Chart, s3: renderStep3Chart };
  for (const [id, el] of Object.entries(slots)) {
    if (el.isConnected) hooks[id](el);
  }
}

// 1단계: 고른 측정의 기본 정보 표 — 질문 1(측정 시간·간격·값 범위)의 재료
function renderStep1Info(slotEl) {
  const picked = pickedDatasets();
  if (!picked.length) {
    slotEl.innerHTML = `<p class="exp1-dim">위에서 측정을 골라 주세요.</p>`;
    return;
  }
  const rows = picked
    .map((d) => {
      const vs = d.points.map((p) => p.v);
      const mins = Math.round((d.points.at(-1)?.t || 0) / 60);
      const evts = (d.events || []).map((e) => `${fmtTime(e.t)} ${e.label}`).join(", ") || "없음";
      return `<tr>
        <td>${d.title}</td><td>${d.condition}</td>
        <td>${mins}분</td><td>${d.intervalSec}초</td>
        <td>${fmtV(Math.min(...vs))} ~ ${fmtV(Math.max(...vs))}</td>
        <td>${evts}</td>
      </tr>`;
    })
    .join("");
  slotEl.innerHTML = `<table class="exp1-table">
    <thead><tr><th>측정</th><th>조건</th><th>측정 시간</th><th>간격</th><th>값 범위</th><th>기록된 일</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// 2단계: 그래프 + 표현 방법 고르기 (선/막대, 기준선 켜고 끄기)
function renderStep2Chart(slotEl) {
  const opts = analysis.chartOptions;
  slotEl.innerHTML = `
    <div class="exp1-controls">
      <label><input type="radio" name="exp1-type" value="line" ${opts.chartType === "line" ? "checked" : ""}> 선그래프</label>
      <label><input type="radio" name="exp1-type" value="bar" ${opts.chartType === "bar" ? "checked" : ""}> 막대그래프</label>
      <label class="exp1-gap"><input type="checkbox" id="exp1-ref" ${opts.showRef ? "checked" : ""}> 기준선 1,000ppm 보이기</label>
    </div>
    <div class="exp1-chartbox"><canvas></canvas></div>
    <p class="exp1-dim" id="exp1-barnote"></p>`;

  slotEl.querySelectorAll("input[name=exp1-type]").forEach((r) =>
    r.addEventListener("change", () => {
      opts.chartType = r.value;
      analysis.chartType = r.value; // §5 스키마의 chartType 필드에도 반영
      saveAnalysis(analysis);
      draw();
    })
  );
  slotEl.querySelector("#exp1-ref").addEventListener("change", (e) => {
    opts.showRef = e.target.checked;
    saveAnalysis(analysis);
    draw();
  });

  const draw = () => drawChart(slotEl.querySelector("canvas"), opts, slotEl.querySelector("#exp1-barnote"));
  draw();
}

// 3단계: 그래프(좌표 확인용) + 자동 계산 표
function renderStep3Chart(slotEl) {
  slotEl.innerHTML = `
    <div class="exp1-chartbox"><canvas></canvas></div>
    <div id="exp1-stats"></div>`;
  drawChart(slotEl.querySelector("canvas"), { chartType: "line", showRef: true });

  const picked = pickedDatasets();
  const statsEl = slotEl.querySelector("#exp1-stats");
  if (!picked.length) {
    statsEl.innerHTML = `<p class="exp1-dim">위에서 측정을 골라 주세요.</p>`;
    return;
  }
  // 자동 계산: 숫자만 보여준다. 해석은 학생 몫 (SPEC §8.4)
  const head = EXP1.stats.map((s) => `<th>${s.label}</th>`).join("");
  const rows = picked
    .map((d) => {
      const st = computeStats(d);
      const cells = EXP1.stats.map((s) => `<td>${st[s.key] ?? "—"}</td>`).join("");
      return `<tr><td>${d.title}</td>${cells}</tr>`;
    })
    .join("");
  statsEl.innerHTML = `<p class="exp1-help">자동 계산 — 내가 그래프에서 짚은 값과 비교해 보세요.</p>
    <table class="exp1-table"><thead><tr><th>측정</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// 고른 측정들을 한 캔버스에 그린다
function drawChart(canvasEl, opts, noteEl) {
  const picked = pickedDatasets();
  if (noteEl) noteEl.textContent = "";
  if (!picked.length) {
    canvasEl.replaceWith(Object.assign(document.createElement("p"), {
      className: "exp1-dim", textContent: "위에서 측정을 골라 주세요.",
    }));
    return;
  }

  const spec = {
    xLabel: EXP1.xLabel,
    yLabel: EXP1.yLabel,
    tooltip: EXP1.tooltip,
    refLine: opts.showRef ? EXP1.refLine : undefined,
  };

  if (opts.chartType === "bar") {
    // 막대그래프는 점 하나가 막대 하나 — 첫 번째 측정만 그려진다 (비교 체험용)
    const d = picked[0];
    spec.type = "bar";
    // 색을 통일하지 않으면 막대마다 다른 색이 돌아가며 칠해진다
    spec.datasets = d.points.map((p) => ({ label: fmtTime(p.t), value: p.v, color: "#2563eb" }));
    if (noteEl && picked.length > 1) noteEl.textContent = `막대그래프에는 첫 번째 측정(${d.title})만 보여요.`;
  } else {
    spec.type = "line";
    spec.datasets = picked.map((d) => ({ label: `${d.title}`, points: d.points }));
    spec.events = picked.flatMap((d) => d.events || []);
  }
  renderChart(canvasEl, spec);
}

// ── 자동 계산 ─────────────────────────────────────────────
// max        : 가장 높았던 값
// riseRate   : 창문(문)을 열기 전 구간의 기울기(ppm/분) — 오르지 않았으면 "—"
// crossTime  : 기준선 아래에서 위로 처음 넘어간 시각 — 처음부터 위였으면 "—"
// recoverTime: "열기" 사건 뒤 기준선 아래로 내려올 때까지 걸린 시간
function computeStats(ds) {
  const ref = EXP1.refLine.value;
  const pts = ds.points;
  const out = {};

  out.max = fmtV(Math.max(...pts.map((p) => p.v)));

  // 기준선을 아래→위로 처음 넘은 순간
  const crossIdx = pts.findIndex((p, i) => i > 0 && pts[i - 1].v < ref && p.v >= ref);
  out.crossTime = crossIdx > 0 ? fmtTime(pts[crossIdx].t) : null;

  // "열기" 사건 (창문 열기 / 문 열기)
  const openEvt = (ds.events || []).find((e) => e.label.includes("열"));

  // 올라간 빠르기: 열기 전(없으면 전체) 구간을 직선으로 근사한 기울기
  const riseEnd = openEvt ? openEvt.t : Infinity;
  const risePts = pts.filter((p) => p.t < riseEnd);
  const slope = fitSlope(risePts); // ppm/초
  out.riseRate = slope > 0.01 ? `1분에 약 ${Math.round(slope * 60)}ppm` : null;

  // 회복 시간: 열기 사건 뒤 처음 기준선 아래로 내려온 순간까지
  if (openEvt) {
    const down = pts.find((p) => p.t >= openEvt.t && p.v < ref);
    out.recoverTime = down ? fmtTime(down.t - openEvt.t) : null;
  } else {
    out.recoverTime = null;
  }
  return out;
}

// 최소제곱법으로 기울기를 구한다 (단위: v/초). 점이 2개 미만이면 0.
function fitSlope(pts) {
  if (pts.length < 2) return 0;
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p.t, 0) / n;
  const mv = pts.reduce((s, p) => s + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.v - mv);
    den += (p.t - mt) ** 2;
  }
  return den ? num / den : 0;
}

// 초 → "19분 40초" (툴팁과 같은 형식이라 학생이 대조하기 쉽다)
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}분 ${String(s).padStart(2, "0")}초`;
}

// 값 + 단위 (예: "1,405 ppm")
function fmtV(v) {
  return `${v.toLocaleString("ko-KR")} ${EXP1.tooltip.valueUnit}`;
}

// ── 이 탭에서만 쓰는 최소 스타일 ──────────────────────────
function injectStyle() {
  if (document.getElementById("exp1-style")) return;
  const style = document.createElement("style");
  style.id = "exp1-style";
  style.textContent = `
    .exp1-header h2 { margin-bottom: 4px; }
    .exp1-question { color: #444; }
    .exp1-box { border: 1px solid #ddd; border-radius: 10px; padding: 12px 16px; margin: 12px 0; }
    .exp1-help, .exp1-dim { color: #777; font-size: 14px; }
    .exp1-item { display: block; padding: 4px 0; cursor: pointer; }
    .exp1-item input { margin-right: 6px; }
    .exp1-practice { margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .exp1-controls { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .exp1-chartbox { position: relative; height: 320px; margin: 8px 0; }
    .exp1-table { border-collapse: collapse; font-size: 14px; margin: 8px 0; width: 100%; }
    .exp1-table th, .exp1-table td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
    .exp1-table th { background: #f6f7f9; }
  `;
  document.head.append(style);
}
