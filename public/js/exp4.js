// js/exp4.js — 실험 4 "물과 식용유, 어느 쪽이 빨리 뜨거워질까(비열)" 탭 (세션 B)
//
// 구조는 js/exp1.js와 같다. 실험 1과 다른 점만 적어 둔다.
//   · 기준선이 없다 → 대신 "얼마나 올랐는지로 보기"(시작 온도를 0으로 맞춤) 전환이 있다
//   · 물질 2개를 겹쳐 그리는 것이 기본이다
//   · 자동 계산의 중심은 온도 상승 속도(℃/분)와 온도 변화량
//   · 가열 실험이라 안전 문구를 화면 맨 위에 항상 띄운다(phase-nav 세 화면 어디서도 계속 보인다)
//
// 화면은 phase-nav.js(세션 A)로 세 단계를 나눠 보여준다:
//   1. 계획 세우기 (config의 designSteps) — 다 채워야 아래 두 화면이 열린다
//   2. 측정하기 (우리 모둠 측정 목록 + 연습 데이터 만들기)
//   3. 분석하기 (분석 5단계 — steps.js의 renderSteps)
//
// 문구·질문·그래프 설정은 전부 config/exp4.config.js에 있다.

import { EXP4 } from "../config/exp4.config.js";
import { listDatasets, saveDataset, getAnalysis, saveAnalysis } from "./data.js";
import { renderChart } from "./chart-kit.js";
import { renderSteps, isStepsComplete } from "./steps.js";
import { renderRawDataTable } from "./raw-data.js";
import { mountAnnotations } from "./annotations.js";
import { getSession } from "./auth.js";
import { renderPhases } from "./phase-nav.js";

// 탭이 열려 있는 동안의 상태 (탭을 다시 열면 mount가 새로 채운다)
let rootEl = null;    // 탭 컨테이너
let session = null;   // { groupId, groupName, ... }
let datasets = [];    // 우리 모둠 측정 목록
let analysis = null;  // 우리 모둠 분석 문서 (getAnalysis 결과)
let slots = {};       // 단계별 render 훅이 그린 자리 — 측정 선택이 바뀌면 다시 그린다
let phaseNav = null;  // renderPhases()가 돌려준 { refresh, goTo }
let phaseSlots = {};  // 화면(phase)마다 render()가 받은 slotEl — 데이터가 바뀌면 그 자리에 다시 그린다

// ── 탭 진입점 (router.js 규약) ─────────────────────────────
export async function mount(containerEl) {
  rootEl = containerEl;
  session = getSession();
  slots = {};
  phaseSlots = {};
  phaseNav = null;
  injectStyle();

  containerEl.innerHTML = `
    <p class="exp4-safety">🔥 <b>안전 먼저!</b> ${EXP4.safety}</p>

    <section class="exp4-header">
      <h2>🌡️ 실험 4 — ${EXP4.title}</h2>
      <p class="exp4-question">탐구 질문: <strong>${EXP4.question}</strong></p>
    </section>
    <div id="exp4-phases"></div>
  `;

  await reload();
}

// 측정 목록과 분석 문서를 불러와 화면을 채운다
async function reload() {
  [datasets, analysis] = await Promise.all([
    listDatasets(EXP4.expNo, session.groupId),
    getAnalysis(EXP4.expNo, session.groupId),
  ]);
  analysis.expNo = EXP4.expNo;
  analysis.groupId = session.groupId;
  // 빈 분석 문서는 chartOptions가 {}로 온다. || 로는 빈 객체가 그대로 남아
  // chartType이 undefined가 되고, Firestore가 저장을 통째로 거부한다.
  analysis.chartOptions = { chartType: "line", showDelta: false, ...(analysis.chartOptions || {}) };
  analysis.chartType = analysis.chartOptions.chartType;
  analysis.annotations = analysis.annotations || []; // 학생이 그래프에 남긴 사건 메모선

  // 지워진 측정은 선택에서 빼고, 아무것도 안 골랐으면 전부 고른 것으로 시작한다
  const ids = datasets.map((d) => d.id);
  let picked = (analysis.datasetIds || []).filter((id) => ids.includes(id));
  if (!picked.length) picked = [...ids];
  analysis.datasetIds = picked;

  if (!phaseNav) {
    // storageKey: 실험 1과 겹치지 않도록 exp4 전용 키. 새로고침해도 보던 화면으로 돌아온다.
    phaseNav = renderPhases(rootEl.querySelector("#exp4-phases"), buildPhases(), {
      storageKey: "sds:phase:exp4:" + session.groupId,
    });
  } else {
    phaseNav.refresh(); // 잠금 칩·다음 버튼 상태를 지금 데이터 기준으로 다시 계산
    refreshPhaseSlots(); // 이미 그려져 있는 화면 내용도 새 데이터로 갱신
  }
}

// ── 화면(phase) 셋 — 계획을 세우기 전에는 측정·분석을 잠가 둔다 ──
// 감추지는 않는다(SPEC §8.4-A). 칩은 그대로 보이되 아직 누를 수 없는 상태로 둔다.
// ★ 이미 잰 측정이 하나라도 있으면 잠그지 않는다. 수집기(별도 앱)로 먼저 잰
//   모둠이 웹앱에서 막히면 수업이 그 자리에서 멈추기 때문이다.
function buildPhases() {
  const isLocked = () => datasets.length === 0 && !isStepsComplete(EXP4.designSteps, analysis);
  const lockMsg = "🔒 먼저 '계획 세우기' 화면에서 세 가지를 다 적어 주세요. 그러면 이 화면이 열려요.";
  return [
    { id: "plan", label: "1. 계획 세우기", render: (el) => { phaseSlots.plan = el; renderPlanPhase(el); } },
    { id: "measure", label: "2. 측정하기", isLocked, lockMsg, render: (el) => { phaseSlots.measure = el; renderMeasurePhase(el); } },
    { id: "analyze", label: "3. 분석하기", isLocked, lockMsg, render: (el) => { phaseSlots.analyze = el; renderAnalyzePhase(el); } },
  ];
}

function refreshPhaseSlots() {
  const renderers = { plan: renderPlanPhase, measure: renderMeasurePhase, analyze: renderAnalyzePhase };
  for (const [id, el] of Object.entries(phaseSlots)) {
    if (el.isConnected) renderers[id](el);
  }
}

// 1. 계획 세우기
function renderPlanPhase(slotEl) {
  slotEl.innerHTML = `
    <section class="exp4-box" id="exp4-design">
      <h3>실험 계획 세우기</h3>
      <p class="exp4-help">불을 켜기 전에 어떻게 실험할지 먼저 정해요. 세 가지를 다 적으면 아래 측정 화면이 열려요.</p>
      <div id="exp4-design-steps"></div>
    </section>
  `;
  // 다 채우면(완료 여부가 바뀌면) 다섯 번째 인자로 알려 준다 — 다른 화면 잠금을 다시 계산한다
  renderSteps(
    slotEl.querySelector("#exp4-design-steps"),
    EXP4.designSteps,
    analysis,
    saveAnalysis,
    () => phaseNav.refresh()
  );
}

// 2. 측정하기
function renderMeasurePhase(slotEl) {
  slotEl.innerHTML = `
    <section class="exp4-box" id="exp4-measure">
      <h3>우리 모둠의 측정</h3>
      <p class="exp4-help">물과 식용유를 함께 골라야 비교할 수 있어요. 고른 측정이 그래프에 겹쳐 그려져요.</p>
      <div id="exp4-list"><p class="exp4-dim">측정 목록을 불러오는 중…</p></div>
      <div class="exp4-practice">
        <label>아직 센서가 없다면 —
          <select id="exp4-cond">
            ${EXP4.conditions.map((c) => `<option>${c}</option>`).join("")}
          </select>
        </label>
        <button id="exp4-make">연습 데이터 만들기</button>
        <span id="exp4-make-msg" class="exp4-dim"></span>
      </div>
    </section>
  `;
  slotEl.querySelector("#exp4-make").addEventListener("click", onMakePractice);
  renderDatasetList(slotEl.querySelector("#exp4-list"));
}

// 3. 분석하기
function renderAnalyzePhase(slotEl) {
  slotEl.innerHTML = `<section id="exp4-steps"></section>`;
  renderSteps(slotEl.querySelector("#exp4-steps"), buildSteps(), analysis, saveAnalysis);
}

// 지금 분석에 골라 둔 측정들
function pickedDatasets() {
  return datasets.filter((d) => analysis.datasetIds.includes(d.id));
}

// ── ② 측정 목록 (체크박스) ────────────────────────────────
function renderDatasetList(listEl) {
  if (!datasets.length) {
    listEl.innerHTML = `<p class="exp4-dim">아직 측정이 없어요. 아래에서 연습 데이터를 만들어 보세요.</p>`;
    return;
  }
  listEl.innerHTML = datasets
    .map((d) => {
      const mins = Math.round((d.points.at(-1)?.t || 0) / 60);
      const checked = analysis.datasetIds.includes(d.id) ? "checked" : "";
      return `<label class="exp4-item">
        <input type="checkbox" data-id="${d.id}" ${checked}>
        <b>${d.title}</b>
        <span class="exp4-dim">${d.condition} · ${mins}분 · ${d.points.length}개 점${d.source === "mock" ? " · 연습" : ""}</span>
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

// "연습 데이터 만들기" — generateMock으로 가짜 측정을 만들어 저장한다
async function onMakePractice() {
  const msgEl = rootEl.querySelector("#exp4-make-msg");
  const cond = rootEl.querySelector("#exp4-cond").value;
  try {
    msgEl.textContent = "만드는 중…";
    const { generateMock } = await import("../mock/mock-data.js");
    const ds = generateMock(EXP4.expNo, cond);
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
  return EXP4.steps.map((step) => {
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

// 두 물질을 고르지 않았을 때 비교가 안 된다는 것을 알려 준다 (답은 알려주지 않는다)
function compareNote(picked) {
  if (picked.length >= 2) return "";
  return `<p class="exp4-note">비교하려면 위에서 물질을 두 가지 이상 골라야 해요.</p>`;
}

// 1단계: 고른 측정의 기본 정보 표 — 공평하게 쟀는지 확인하는 재료
function renderStep1Info(slotEl) {
  const picked = pickedDatasets();
  if (!picked.length) {
    slotEl.innerHTML = `<p class="exp4-dim">위에서 측정을 골라 주세요.</p>`;
    return;
  }
  const rows = picked
    .map((d) => {
      const mins = Math.round((d.points.at(-1)?.t || 0) / 60);
      const evts = (d.events || []).map((e) => `${fmtTime(e.t)} ${e.label}`).join(", ") || "없음";
      return `<tr>
        <td>${d.title}</td><td>${d.condition}</td>
        <td>${mins}분</td><td>${d.intervalSec}초</td>
        <td>${d.points.length ? fmtV(d.points[0].v) : "값 없음"}</td>
        <td>${d.points.length ? fmtV(d.points.at(-1).v) : "값 없음"}</td>
        <td>${evts}</td>
      </tr>`;
    })
    .join("");
  slotEl.innerHTML = `<table class="exp4-table">
    <thead><tr><th>측정</th><th>물질</th><th>측정 시간</th><th>간격</th><th>시작 온도</th><th>끝 온도</th><th>기록된 일</th></tr></thead>
    <tbody>${rows}</tbody></table>${compareNote(picked)}
    <p class="exp4-help">아래는 센서가 기록한 값 그대로예요. 표를 넘겨 보거나 파일로 내려받아 확인해 보세요.</p>
    <div id="exp4-raw"></div>`;

  // 원본 측정값 표 + CSV 내려받기 (raw-data.js, 읽기 전용)
  renderRawDataTable(slotEl.querySelector("#exp4-raw"), picked, "측정데이터_실험4");
}

// 2단계: 그래프 + 보는 방식 고르기 (선/막대, 시작 온도를 0으로 맞춰 보기)
function renderStep2Chart(slotEl) {
  const opts = analysis.chartOptions;
  slotEl.innerHTML = `
    <div class="exp4-controls">
      <label><input type="radio" name="exp4-type" value="line" ${opts.chartType === "line" ? "checked" : ""}> 선그래프</label>
      <label><input type="radio" name="exp4-type" value="bar" ${opts.chartType === "bar" ? "checked" : ""}> 막대그래프</label>
      <label class="exp4-gap"><input type="checkbox" id="exp4-delta" ${opts.showDelta ? "checked" : ""}> 얼마나 올랐는지로 보기</label>
    </div>
    <div class="exp4-chartbox"><canvas></canvas></div>
    <p class="exp4-dim" id="exp4-barnote"></p>
    <div id="exp4-anno"></div>`;

  // 사건 메모선 — 입력칸·목록·지우기는 공통 모듈이 맡는다.
  // ★ 여기서 딱 한 번만 붙인다. draw() 안에서 붙이면 그래프를 다시 그릴 때마다
  //   학생이 쓰던 메모 글이 지워진다.
  const anno = mountAnnotations(slotEl.querySelector("#exp4-anno"), {
    analysis,
    onSave: saveAnalysis,
    onChange: () => draw(), // 메모가 늘거나 줄면 그래프를 다시 그린다
    placeholder: "예) 불 켜기",
  });

  slotEl.querySelectorAll("input[name=exp4-type]").forEach((r) =>
    r.addEventListener("change", () => {
      opts.chartType = r.value;
      analysis.chartType = r.value; // §5 스키마의 chartType 필드에도 반영
      saveAnalysis(analysis);
      draw();
    })
  );
  slotEl.querySelector("#exp4-delta").addEventListener("change", (e) => {
    opts.showDelta = e.target.checked;
    saveAnalysis(analysis);
    draw();
  });

  // 그래프를 누르면 그 시각에 메모선을 남길 수 있다 (선그래프에서만 — 막대에는 시간축이 없다)
  const draw = () => {
    drawChart(
      slotEl.querySelector(".exp4-chartbox"),
      { ...opts, onPickTime: anno.openAt },
      slotEl.querySelector("#exp4-barnote")
    );
    if (opts.chartType !== "line") anno.close(); // 막대그래프에서는 열려 있던 입력칸을 닫는다
    anno.refresh();
  };

  draw();
}

// 3단계: 그래프(좌표 확인용) + 자동 계산 표
function renderStep3Chart(slotEl) {
  const picked = pickedDatasets();
  slotEl.innerHTML = `
    <div class="exp4-chartbox"><canvas></canvas></div>
    <div id="exp4-stats"></div>`;
  // 3단계에서는 원래 온도로 본다. 정확한 값을 그래프에서 읽어야 하는 질문들이기 때문이다.
  // 2단계에서 단 메모선도 함께 보인다 (여기서는 새로 찍지 않고 패턴과 견주어 보기만 한다)
  drawChart(slotEl.querySelector(".exp4-chartbox"), { chartType: "line", showDelta: false });

  const statsEl = slotEl.querySelector("#exp4-stats");
  if (!picked.length) {
    statsEl.innerHTML = `<p class="exp4-dim">위에서 측정을 골라 주세요.</p>`;
    return;
  }
  // 자동 계산: 숫자만 보여준다. 해석은 학생 몫 (SPEC §8.4)
  const head = EXP4.stats.map((s) => `<th>${s.label}</th>`).join("");
  const rows = picked
    .map((d) => {
      const st = computeStats(d);
      const cells = EXP4.stats.map((s) => `<td>${st[s.key] ?? "—"}</td>`).join("");
      return `<tr><td>${d.title}</td>${cells}</tr>`;
    })
    .join("");
  statsEl.innerHTML = `<p class="exp4-help">자동 계산 — 내가 그래프에서 짚은 값과 비교해 보세요.</p>
    <table class="exp4-table"><thead><tr><th>측정</th>${head}</tr></thead><tbody>${rows}</tbody></table>
    ${compareNote(picked)}`;
}

// 고른 측정들을 한 캔버스에 그린다.
// boxEl은 캔버스를 감싼 상자 — 측정을 하나도 고르지 않았을 때 안내로 바꿔 넣기 위해 받는다.
function drawChart(boxEl, opts, noteEl) {
  const picked = pickedDatasets();
  if (noteEl) noteEl.textContent = "";
  boxEl.innerHTML = "<canvas></canvas>";
  if (!picked.length) {
    boxEl.innerHTML = `<p class="exp4-dim">위에서 측정을 골라 주세요.</p>`;
    return;
  }
  const canvasEl = boxEl.querySelector("canvas");

  // "얼마나 올랐는지로 보기" — 각 측정의 시작 온도를 빼서 0에서 출발시킨다.
  // 시작 온도가 서로 달라도 공평하게 견줄 수 있는지 학생이 직접 확인하는 장치다.
  const delta = Boolean(opts.showDelta);
  // 값이 하나도 없는 측정이면 뺄 기준도 없다 (0으로 두면 빈 선이 그려질 뿐 화면이 죽지 않는다)
  const shift = (d) => (delta && d.points.length ? d.points[0].v : 0);

  const spec = {
    xLabel: EXP4.xLabel,
    yLabel: delta ? "시작보다 오른 온도 (℃)" : EXP4.yLabel,
    tooltip: { ...EXP4.tooltip, valueLabel: delta ? "오른 온도" : EXP4.tooltip.valueLabel },
  };

  if (opts.chartType === "bar") {
    // 막대그래프는 점 하나가 막대 하나 — 첫 번째 측정만 그려진다 (비교 체험용)
    const d = picked[0];
    const base = shift(d);
    spec.type = "bar";
    spec.datasets = d.points.map((p) => ({
      label: fmtTime(p.t),
      value: round1(p.v - base),
      color: "#2563eb",
    }));
    // 막대그래프에는 시간축이 없으므로 메모선을 찍을 수 없다
    if (noteEl) {
      noteEl.textContent = `막대그래프에는 첫 번째 측정(${d.title})만 보여요. 메모선은 선그래프에서만 찍을 수 있어요.`;
    }
  } else {
    spec.type = "line";
    spec.datasets = picked.map((d) => {
      const base = shift(d);
      return {
        label: d.title,
        points: d.points.map((p) => ({ t: p.t, v: round1(p.v - base) })),
      };
    });
    spec.events = picked.flatMap((d) => d.events || []); // 회색 — 수집기 원본("가열 시작" 등, 건드리지 않는다)
    spec.annotations = analysis.annotations;             // 빨강 — 학생이 단 메모 (analysis에만 저장)
    if (opts.onPickTime) spec.onAddAnnotation = opts.onPickTime;
  }
  renderChart(canvasEl, spec);
}

// ── 자동 계산 ─────────────────────────────────────────────
// startTemp : 시작 온도
// endTemp   : 끝 온도
// deltaT    : 온도 변화량 (끝 − 시작)
// riseRate  : 온도 상승 속도(℃/분) — 이 실험의 핵심 비교값.
//             "가열 시작" 기록이 있으면 그 뒤 구간만으로 계산한다.
function computeStats(ds) {
  const pts = ds.points;
  const out = {};

  // 값이 하나도 없는 측정(수집기 오류 등). pts[0].v를 그대로 읽으면 화면이 죽는다.
  // 전부 null로 두면 표에 "—"로 나온다.
  if (!pts.length) return { startTemp: null, endTemp: null, deltaT: null, riseRate: null };

  const first = pts[0].v;
  const last = pts.at(-1).v;

  out.startTemp = fmtV(first);
  out.endTemp = fmtV(last);
  out.deltaT = `${last - first >= 0 ? "+" : ""}${(last - first).toFixed(1)} ℃`;

  const heatEvt = (ds.events || []).find((e) => /가열|시작/.test(e.label));
  const usePts = heatEvt ? pts.filter((p) => p.t >= heatEvt.t) : pts;
  const slope = fitSlope(usePts); // ℃/초
  out.riseRate = usePts.length >= 2 ? `1분에 약 ${round1(slope * 60)}℃` : null;

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

// 초 → "5분 00초" (툴팁과 같은 형식이라 학생이 대조하기 쉽다)
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}분 ${String(s).padStart(2, "0")}초`;
}

// 온도는 소수 첫째 자리까지 (센서 값과 같은 자리수)
function round1(v) {
  return Math.round(v * 10) / 10;
}

// 값 + 단위 (예: "23.1 ℃"). 센서 표기와 맞춰 소수 첫째 자리까지 항상 보여준다
function fmtV(v) {
  return `${v.toFixed(1)} ${EXP4.tooltip.valueUnit}`;
}

// ── 이 탭에서만 쓰는 최소 스타일 ──────────────────────────
function injectStyle() {
  if (document.getElementById("exp4-style")) return;
  const style = document.createElement("style");
  style.id = "exp4-style";
  style.textContent = `
    .exp4-safety { background: #fff4e5; border: 1px solid #f5b878; border-left: 6px solid #f59e0b;
                   border-radius: 8px; padding: 10px 14px; margin: 12px 0; line-height: 1.6; }
    .exp4-header h2 { margin-bottom: 4px; }
    .exp4-question { color: #444; }
    .exp4-box { border: 1px solid #ddd; border-radius: 10px; padding: 12px 16px; margin: 12px 0; }
    .exp4-help, .exp4-dim { color: #777; font-size: 14px; }
    .exp4-note { color: #b45309; font-size: 14px; margin: 6px 0 0; }
    .exp4-item { display: block; padding: 4px 0; cursor: pointer; }
    .exp4-item input { margin-right: 6px; }
    .exp4-practice { margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .exp4-controls { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .exp4-chartbox { position: relative; height: 320px; margin: 8px 0; }
    .exp4-table { border-collapse: collapse; font-size: 14px; margin: 8px 0; width: 100%; }
    .exp4-table th, .exp4-table td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
    .exp4-table th { background: #f6f7f9; }
    /* 화면(계획/측정/분석) 전환 UI 스타일은 css/style.css의 .phase-* 규칙을 쓴다 */
    /* 사건 메모선 입력칸·목록 스타일은 js/annotations.js가 직접 넣는다 */
  `;
  document.head.append(style);
}
