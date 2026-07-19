// js/exp2.js — 실험 2 "교실 식물 최적 조건 찾기" 탭 (세션 C)
//
// 화면 구성 (위 → 아래):
//   ① 탐구 질문 헤더
//   ② 우리 모둠 측정 목록 + 연습 데이터 만들기 + 분석에 쓸 측정 고르기
//   ③ 분석 5단계 (steps.js의 renderSteps) — 변인 기록·그래프·자동 계산은 render 훅으로 끼움
//
// 문구·질문·그래프 설정은 전부 config/exp2.config.js에 있다.

import { EXP2 } from "../config/exp2.config.js";
import { listDatasets, saveDataset, getAnalysis, saveAnalysis } from "./data.js";
import { renderChart } from "./chart-kit.js";
import { renderSteps } from "./steps.js";
import { getSession } from "./auth.js";

let rootEl = null;
let session = null;
let datasets = [];
let analysis = null;
let slots = {}; // 단계별 render 훅이 그린 자리 — 측정 선택이 바뀌면 다시 그린다

// ── 탭 진입점 (router.js 규약) ─────────────────────────────
export async function mount(containerEl) {
  rootEl = containerEl;
  session = getSession();
  slots = {};
  injectStyle();

  containerEl.innerHTML = `
    <section class="exp2-header">
      <h2>🌱 실험 2 — ${EXP2.title}</h2>
      <p class="exp2-question">탐구 질문: <strong>${EXP2.question}</strong></p>
    </section>

    <section class="exp2-box">
      <h3>우리 모둠의 측정</h3>
      <p class="exp2-help">분석에 쓸 측정을 골라 주세요. 같은 조건을 여러 번 쟀다면 모두 골라 평균을 낼 수 있어요.</p>
      <div id="exp2-list"><p class="exp2-dim">측정 목록을 불러오는 중…</p></div>
      <div class="exp2-practice">
        <label>아직 센서가 없다면 —
          <select id="exp2-cond">
            ${EXP2.conditions.map((c) => `<option>${c}</option>`).join("")}
          </select>
        </label>
        <button id="exp2-make">연습 데이터 만들기</button>
        <span id="exp2-make-msg" class="exp2-dim"></span>
      </div>
    </section>

    <section id="exp2-steps"></section>
  `;

  containerEl.querySelector("#exp2-make").addEventListener("click", onMakePractice);
  await reload();
}

// 측정 목록과 분석 문서를 불러와 화면을 채운다
async function reload() {
  [datasets, analysis] = await Promise.all([
    listDatasets(EXP2.expNo, session.groupId),
    getAnalysis(EXP2.expNo, session.groupId),
  ]);
  analysis.expNo = EXP2.expNo;
  analysis.groupId = session.groupId;
  // chartOptions: 그래프 설정 + 변인 기록(§5 스키마의 자유 객체 필드를 그대로 씀)
  analysis.chartOptions = analysis.chartOptions || {};
  analysis.chartOptions.chartType = analysis.chartOptions.chartType || "bar";
  analysis.chartOptions.showControlLine = analysis.chartOptions.showControlLine ?? true;
  analysis.chartOptions.manipulated = analysis.chartOptions.manipulated || "";
  analysis.chartOptions.controlled = analysis.chartOptions.controlled || "";
  analysis.chartType = analysis.chartOptions.chartType;

  // 지워진 측정은 선택에서 빼고, 아무것도 안 골랐으면 전부 고른 것으로 시작한다
  const ids = datasets.map((d) => d.id);
  let picked = (analysis.datasetIds || []).filter((id) => ids.includes(id));
  if (!picked.length) picked = [...ids];
  analysis.datasetIds = picked;

  renderDatasetList(rootEl.querySelector("#exp2-list"));
  renderSteps(rootEl.querySelector("#exp2-steps"), buildSteps(), analysis, saveAnalysis);
}

// 지금 분석에 골라 둔 측정들
function pickedDatasets() {
  return datasets.filter((d) => analysis.datasetIds.includes(d.id));
}

// 고른 측정을 조건별로 묶는다 — { 조건명: [dataset, ...] }
function groupByCondition(list) {
  const map = new Map();
  for (const d of list) {
    const key = d.condition || "(조건 없음)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  }
  return map;
}

// ── ② 측정 목록 (체크박스) ────────────────────────────────
function renderDatasetList(listEl) {
  if (!datasets.length) {
    listEl.innerHTML = `<p class="exp2-dim">아직 측정이 없어요. 아래에서 연습 데이터를 만들어 보세요.</p>`;
    return;
  }
  listEl.innerHTML = datasets
    .map((d) => {
      const mins = Math.round((d.points.at(-1)?.t || 0) / 60);
      const checked = analysis.datasetIds.includes(d.id) ? "checked" : "";
      return `<label class="exp2-item">
        <input type="checkbox" data-id="${d.id}" ${checked}>
        <b>${d.title}</b>
        <span class="exp2-dim">${d.condition} · ${mins}분 · ${d.points.length}개 점${d.source === "mock" ? " · 연습" : ""}</span>
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
      refreshSlots(); // 열려 있는 단계의 내용을 새로 그린다
    });
  });
}

// "연습 데이터 만들기" — generateMock으로 가짜 측정을 만들어 저장한다.
// mock/ 폴더는 배포에 포함되지 않을 수 있어 동적 import + 실패 안내로 감싼다.
async function onMakePractice() {
  const msgEl = rootEl.querySelector("#exp2-make-msg");
  const cond = rootEl.querySelector("#exp2-cond").value;
  try {
    msgEl.textContent = "만드는 중…";
    const { generateMock } = await import("../mock/mock-data.js");
    const ds = generateMock(EXP2.expNo, cond);
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
  const hooks = { s1: renderStep1Vars, s2: renderStep2Chart, s3: renderStep3Chart };
  return EXP2.steps.map((step) => {
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
  const hooks = { s1: renderStep1Vars, s2: renderStep2Chart, s3: renderStep3Chart };
  for (const [id, el] of Object.entries(slots)) {
    if (el.isConnected) hooks[id](el);
  }
}

// 1단계: 변인 기록 UI + 조건별 반복 횟수 표
// (특수 기능 — SPEC §10.2. 저장 위치는 analysis.chartOptions.manipulated/.controlled)
function renderStep1Vars(slotEl) {
  const opts = analysis.chartOptions;
  slotEl.innerHTML = `
    <div class="exp2-vars">
      <label>${EXP2.variablePrompts.manipulated}
        <input id="exp2-manip" type="text" value="${escapeAttr(opts.manipulated)}">
      </label>
      <label>${EXP2.variablePrompts.controlled}
        <input id="exp2-ctrl" type="text" value="${escapeAttr(opts.controlled)}">
      </label>
    </div>
    <div id="exp2-condtable"></div>
  `;

  let saveTimer = null;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveAnalysis(analysis), 1000);
  };
  slotEl.querySelector("#exp2-manip").addEventListener("input", (e) => {
    opts.manipulated = e.target.value;
    queueSave();
  });
  slotEl.querySelector("#exp2-ctrl").addEventListener("input", (e) => {
    opts.controlled = e.target.value;
    queueSave();
  });

  // 조건별 반복 횟수 — 학생이 1단계 질문("몇 번씩 반복했나요?")에 답할 재료
  const picked = pickedDatasets();
  const tableEl = slotEl.querySelector("#exp2-condtable");
  if (!picked.length) {
    tableEl.innerHTML = `<p class="exp2-dim">위에서 측정을 골라 주세요.</p>`;
    return;
  }
  const groups = groupByCondition(picked);
  const rows = [...groups.entries()]
    .map(([cond, list]) => `<tr><td>${cond}</td><td>${list.length}번</td></tr>`)
    .join("");
  tableEl.innerHTML = `<table class="exp2-table">
    <thead><tr><th>조건</th><th>반복 횟수</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// 2단계: 그래프 표현 방법 고르기 (막대/선, 대조군 기준선 켜고 끄기)
function renderStep2Chart(slotEl) {
  const opts = analysis.chartOptions;
  slotEl.innerHTML = `
    <div class="exp2-controls">
      <label><input type="radio" name="exp2-type" value="bar" ${opts.chartType === "bar" ? "checked" : ""}> 막대그래프(조건별 변화량)</label>
      <label><input type="radio" name="exp2-type" value="line" ${opts.chartType === "line" ? "checked" : ""}> 선그래프(원본 시계열)</label>
      <label class="exp2-gap"><input type="checkbox" id="exp2-ctrline" ${opts.showControlLine ? "checked" : ""}> 대조군 평균 선 보이기</label>
    </div>
    <div class="exp2-chartbox"><canvas></canvas></div>
    <p class="exp2-dim" id="exp2-note"></p>`;

  slotEl.querySelectorAll("input[name=exp2-type]").forEach((r) =>
    r.addEventListener("change", () => {
      opts.chartType = r.value;
      analysis.chartType = r.value; // §5 스키마의 chartType 필드에도 반영
      saveAnalysis(analysis);
      draw();
    })
  );
  slotEl.querySelector("#exp2-ctrline").addEventListener("change", (e) => {
    opts.showControlLine = e.target.checked;
    saveAnalysis(analysis);
    draw();
  });

  const draw = () => drawChart(slotEl.querySelector("canvas"), opts, slotEl.querySelector("#exp2-note"));
  draw();
}

// 3단계: 막대그래프(좌표 확인용, 조건별 변화량 비교가 목적이라 항상 막대로 고정) + 자동 계산 표
function renderStep3Chart(slotEl) {
  slotEl.innerHTML = `
    <div class="exp2-chartbox"><canvas></canvas></div>
    <div id="exp2-stats"></div>`;
  drawChart(slotEl.querySelector("canvas"), { chartType: "bar", showControlLine: true });

  const picked = pickedDatasets();
  const statsEl = slotEl.querySelector("#exp2-stats");
  if (!picked.length) {
    statsEl.innerHTML = `<p class="exp2-dim">위에서 측정을 골라 주세요.</p>`;
    return;
  }
  // 자동 계산: 숫자만 보여준다. 해석은 학생 몫 (SPEC §8.4)
  const statsMap = computeConditionStats(picked);
  const head = EXP2.stats.map((s) => `<th>${s.label}</th>`).join("");
  const rows = orderedConditions(statsMap)
    .map((cond) => {
      const st = statsMap.get(cond);
      const cells = EXP2.stats.map((s) => `<td>${fmtStat(s.key, st)}</td>`).join("");
      return `<tr><td>${cond}</td>${cells}</tr>`;
    })
    .join("");
  statsEl.innerHTML = `<p class="exp2-help">자동 계산 — 내가 막대에서 짚은 값과 비교해 보세요.</p>
    <table class="exp2-table"><thead><tr><th>조건</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// 고른 측정들을 한 캔버스에 그린다 (막대: 조건별 평균 변화량 / 선: 원본 시계열 겹쳐보기)
function drawChart(canvasEl, opts, noteEl) {
  const picked = pickedDatasets();
  if (noteEl) noteEl.textContent = "";
  if (!picked.length) {
    canvasEl.replaceWith(Object.assign(document.createElement("p"), {
      className: "exp2-dim", textContent: "위에서 측정을 골라 주세요.",
    }));
    return;
  }

  const spec = {};

  if (opts.chartType === "bar") {
    const statsMap = computeConditionStats(picked);
    const order = orderedConditions(statsMap);
    spec.type = "bar";
    spec.xLabel = "조건";
    spec.yLabel = "CO₂ 변화량 (ppm)";
    spec.datasets = order.map((cond) => ({ label: cond, value: round1(statsMap.get(cond).change), color: "#10b981" }));
    spec.tooltip = {
      ...EXP2.barTooltip,
      extra: (point) => {
        const st = statsMap.get(order[Math.round(point.x)]);
        if (!st) return "";
        return `반복 ${st.n}회 · 편차 ${st.spread != null ? round1(st.spread) + " ppm" : "—(1회뿐)"}`;
      },
    };
    if (opts.showControlLine && statsMap.has(EXP2.controlCondition)) {
      const cVal = round1(statsMap.get(EXP2.controlCondition).change);
      spec.refLine = { value: cVal, label: `대조군 평균 ${signed(cVal)}ppm`, color: EXP2.controlLineColor };
    } else if (opts.showControlLine && noteEl) {
      noteEl.textContent = `대조군(${EXP2.controlCondition}) 측정을 고르면 기준 선이 함께 보여요.`;
    }
  } else {
    spec.type = "line";
    spec.xLabel = EXP2.xLabel;
    spec.yLabel = EXP2.yLabel;
    spec.tooltip = EXP2.tooltip;
    spec.datasets = picked.map((d) => ({ label: `${d.title} (${d.condition})`, points: d.points }));
    spec.events = picked.flatMap((d) => d.events || []);
  }
  renderChart(canvasEl, spec);
}

// ── 자동 계산 (조건별로 묶어서 계산) — change: 평균 변화량(ppm), rate: 평균 변화 속도(ppm/분), spread: 반복 2회 이상일 때만 표준편차 ──
function computeConditionStats(list) {
  const out = new Map();
  for (const [cond, arr] of groupByCondition(list)) {
    const changes = arr.map(sampleChange);
    const rates = arr.map(sampleRate);
    out.set(cond, {
      n: arr.length,
      change: avg(changes),
      rate: avg(rates),
      spread: arr.length > 1 ? stdev(changes) : null,
    });
  }
  return out;
}

// EXP2.conditions 순서를 우선하고, 목록에 없는(학생이 직접 적은) 조건은 뒤에 붙인다
function orderedConditions(statsMap) {
  const known = EXP2.conditions.filter((c) => statsMap.has(c));
  const extra = [...statsMap.keys()].filter((c) => !EXP2.conditions.includes(c));
  return [...known, ...extra];
}

function sampleChange(d) { return d.points[0].v - d.points.at(-1).v; }
function sampleRate(d) {
  const minutes = (d.points.at(-1)?.t || 0) / 60;
  return minutes ? sampleChange(d) / minutes : 0;
}
function avg(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function stdev(arr) {
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}
function round1(v) { return Math.round(v * 10) / 10; }
function signed(v) { return (v > 0 ? "+" : "") + v.toLocaleString("ko-KR"); }

// 표의 각 칸 — key는 EXP2.stats의 key와 맞춘다
function fmtStat(key, st) {
  if (key === "n") return `${st.n}번`;
  if (key === "change") return `${signed(round1(st.change))} ppm`;
  if (key === "rate") return `${signed(round1(st.rate))} ppm`;
  if (key === "spread") return st.spread != null ? `${round1(st.spread)} ppm` : "—";
  return "—";
}

function escapeAttr(s) { return String(s || "").replace(/"/g, "&quot;"); }

// ── 이 탭에서만 쓰는 최소 스타일 ──────────────────────────
function injectStyle() {
  if (document.getElementById("exp2-style")) return;
  const style = document.createElement("style");
  style.id = "exp2-style";
  style.textContent = `
    .exp2-header h2 { margin-bottom: 4px; }
    .exp2-question { color: #444; }
    .exp2-box { border: 1px solid #ddd; border-radius: 10px; padding: 12px 16px; margin: 12px 0; }
    .exp2-help, .exp2-dim { color: #777; font-size: 14px; }
    .exp2-item { display: block; padding: 4px 0; cursor: pointer; }
    .exp2-item input { margin-right: 6px; }
    .exp2-practice { margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .exp2-controls { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .exp2-gap { margin-left: 8px; }
    .exp2-chartbox { position: relative; height: 320px; margin: 8px 0; }
    .exp2-vars { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
    .exp2-vars label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: #333; }
    .exp2-vars input[type=text] { padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; }
    .exp2-table { border-collapse: collapse; font-size: 14px; margin: 8px 0; width: 100%; }
    .exp2-table th, .exp2-table td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
    .exp2-table th { background: #f6f7f9; }
  `;
  document.head.append(style);
}
