// js/exp1.js — 실험 1 "우리 교실 최적 환기 주기 찾기" 탭 (세션 B)
//
// 화면 구성 (위 → 아래):
//   ① 탐구 질문 헤더
//   ② 실험 계획 세우기 (config의 designSteps) — 다 채워야 아래가 열린다
//   ③ 우리 모둠 측정 목록 + 연습 데이터 만들기 + 분석에 쓸 측정 고르기
//   ④ 분석 5단계 (steps.js의 renderSteps) — 그래프·자동 계산은 render 훅으로 끼움
//
// 문구·질문·그래프 설정은 전부 config/exp1.config.js에 있다.

import { EXP1 } from "../config/exp1.config.js";
import { listDatasets, saveDataset, getAnalysis, saveAnalysis } from "./data.js";
import { renderChart } from "./chart-kit.js";
import { renderSteps, isStepsComplete } from "./steps.js";
import { renderRawDataTable } from "./raw-data.js";
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

    <section class="exp1-box" id="exp1-design">
      <h3>실험 계획 세우기</h3>
      <p class="exp1-help">재기 전에 어떻게 실험할지 먼저 정해요. 세 가지를 다 적으면 아래 측정 화면이 열려요.</p>
      <div id="exp1-design-steps"></div>
    </section>

    <p class="exp1-lockmsg" id="exp1-lockmsg" hidden></p>

    <section class="exp1-box" id="exp1-measure">
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
  // 빈 분석 문서는 chartOptions가 {}로 온다. || 로는 빈 객체가 그대로 남아
  // chartType이 undefined가 되고, Firestore가 저장을 통째로 거부한다.
  analysis.chartOptions = { chartType: "line", showRef: true, ...(analysis.chartOptions || {}) };
  analysis.chartType = analysis.chartOptions.chartType;
  analysis.annotations = analysis.annotations || []; // 학생이 그래프에 남긴 사건 메모선

  // 지워진 측정은 선택에서 빼고, 아무것도 안 골랐으면 전부 고른 것으로 시작한다
  const ids = datasets.map((d) => d.id);
  let picked = (analysis.datasetIds || []).filter((id) => ids.includes(id));
  if (!picked.length) picked = [...ids];
  analysis.datasetIds = picked;

  // 실험 계획 단계 — 다 채우면 (다섯 번째 인자로) 알려 준다
  renderSteps(
    rootEl.querySelector("#exp1-design-steps"),
    EXP1.designSteps,
    analysis,
    saveAnalysis,
    () => applyLock()
  );

  renderDatasetList(rootEl.querySelector("#exp1-list"));
  renderSteps(rootEl.querySelector("#exp1-steps"), buildSteps(), analysis, saveAnalysis);
  applyLock(); // 새로고침으로 다시 들어온 모둠도 지금 상태로 판단한다
}

// ── ② 계획을 세우기 전에는 측정·분석을 잠가 둔다 ──────────
// 감추지는 않는다. 무엇이 기다리는지는 보이되 아직 누를 수 없는 상태로 둔다.
// ★ 이미 잰 측정이 하나라도 있으면 잠그지 않는다. 수집기(별도 앱)로 먼저 잰
//   모둠이 웹앱에서 막히면 수업이 그 자리에서 멈추기 때문이다.
function applyLock() {
  const locked = datasets.length === 0 && !isStepsComplete(EXP1.designSteps, analysis);
  const msgEl = rootEl.querySelector("#exp1-lockmsg");
  msgEl.hidden = !locked;
  msgEl.textContent = locked
    ? "🔒 먼저 실험 계획을 세워 보세요. 위 세 단계를 다 적으면 아래에서 측정을 시작할 수 있어요."
    : "";
  for (const sel of ["#exp1-measure", "#exp1-steps"]) {
    const el = rootEl.querySelector(sel);
    el.classList.toggle("exp1-locked", locked);
    el.inert = locked; // 잠긴 동안은 누르기·글쓰기가 되지 않는다
  }
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
    <tbody>${rows}</tbody></table>
    <p class="exp1-help">아래는 센서가 기록한 값 그대로예요. 표를 넘겨 보거나 파일로 내려받아 확인해 보세요.</p>
    <div id="exp1-raw"></div>`;

  // 원본 측정값 표 + CSV 내려받기 (raw-data.js, 읽기 전용)
  renderRawDataTable(slotEl.querySelector("#exp1-raw"), picked, "측정데이터_실험1");
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
    <p class="exp1-dim" id="exp1-barnote"></p>
    <div id="exp1-anno-form"></div>
    <div id="exp1-anno-list"></div>`;

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

  // 그래프를 누르면 그 시각에 메모선을 남길 수 있다 (선그래프에서만 — 막대에는 시간축이 없다)
  const draw = () => {
    const canvasEl = slotEl.querySelector("canvas");
    if (!canvasEl) return; // 고른 측정이 없으면 캔버스가 안내 문구로 바뀌어 있다
    drawChart(canvasEl, { ...opts, onPickTime: openAnnoForm }, slotEl.querySelector("#exp1-barnote"));
    if (opts.chartType !== "line") slotEl.querySelector("#exp1-anno-form").innerHTML = "";
    renderAnnoList(slotEl, draw);
  };

  // 클릭한 시각(초)에 대한 라벨 입력칸을 그래프 아래에 연다.
  // ★ prompt()·alert()를 쓰지 않는다 — 화면 안 입력칸으로 만든다.
  function openAnnoForm(t) {
    const formEl = slotEl.querySelector("#exp1-anno-form");
    formEl.innerHTML = `
      <div class="exp1-anno-form">
        <label for="exp1-anno-text"><b>${fmtTime(t)}</b>에 무슨 일이 있었나요?</label>
        <div class="exp1-anno-row">
          <input type="text" id="exp1-anno-text" maxlength="20" placeholder="예) 창문 열기">
          <button type="button" id="exp1-anno-add">메모선 남기기</button>
          <button type="button" id="exp1-anno-cancel" class="exp1-ghost">그만두기</button>
        </div>
        <p class="exp1-dim" id="exp1-anno-msg"></p>
      </div>`;
    const input = formEl.querySelector("#exp1-anno-text");
    input.focus();

    const add = () => {
      const label = input.value.trim();
      if (!label) {
        formEl.querySelector("#exp1-anno-msg").textContent = "무슨 일이 있었는지 한 줄만 적어 주세요.";
        input.focus();
        return;
      }
      analysis.annotations.push({ t: Math.round(t), label });
      analysis.annotations.sort((a, b) => a.t - b.t);
      saveAnalysis(analysis);
      formEl.innerHTML = "";
      draw();
    };
    formEl.querySelector("#exp1-anno-add").addEventListener("click", add);
    formEl.querySelector("#exp1-anno-cancel").addEventListener("click", () => (formEl.innerHTML = ""));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") add();
      if (e.key === "Escape") formEl.innerHTML = "";
    });
  }

  draw();
}

// 내가 단 메모선 목록 (+ 지우기). config s2 힌트가 "메모 목록에서 지울 수 있어요"라고
// 안내하므로 이 목록이 없으면 화면 문구가 거짓말이 된다.
function renderAnnoList(slotEl, draw) {
  const listEl = slotEl.querySelector("#exp1-anno-list");
  if (!listEl) return;
  const notes = analysis.annotations;
  if (!notes.length) {
    listEl.innerHTML = `<p class="exp1-dim">그래프를 누르면 그 시각에 빨간 메모선을 남길 수 있어요.</p>`;
    return;
  }
  listEl.innerHTML = `<p class="exp1-help">내가 단 메모선</p>
    <ul class="exp1-anno-ul">${notes
      .map(
        (a, i) => `<li><b>${fmtTime(a.t)}</b> · ${escapeText(a.label)}
          <button type="button" class="exp1-ghost" data-i="${i}">지우기</button></li>`
      )
      .join("")}</ul>`;
  listEl.querySelectorAll("button[data-i]").forEach((btn) => {
    btn.addEventListener("click", () => {
      analysis.annotations.splice(Number(btn.dataset.i), 1);
      saveAnalysis(analysis);
      draw();
    });
  });
}

// 학생이 쓴 글자를 표에 넣기 전에 태그로 읽히지 않게 한다
function escapeText(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 3단계: 그래프(좌표 확인용) + 자동 계산 표
function renderStep3Chart(slotEl) {
  slotEl.innerHTML = `
    <div class="exp1-chartbox"><canvas></canvas></div>
    <div id="exp1-stats"></div>`;
  // 2단계에서 단 메모선도 함께 보인다 (여기서는 새로 찍지 않고 패턴과 견주어 보기만 한다)
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
    if (noteEl) {
      const head = picked.length > 1 ? `막대그래프에는 첫 번째 측정(${d.title})만 보여요. ` : "";
      // 막대그래프에는 시간축이 없으므로 메모선을 찍을 수 없다
      noteEl.textContent = `${head}메모선은 선그래프에서만 찍을 수 있어요.`;
    }
  } else {
    spec.type = "line";
    spec.datasets = picked.map((d) => ({ label: `${d.title}`, points: d.points }));
    spec.events = picked.flatMap((d) => d.events || []);   // 회색 — 수집기가 기록한 원본 (건드리지 않는다)
    spec.annotations = analysis.annotations;               // 빨강 — 학생이 단 메모 (analysis에만 저장)
    if (opts.onPickTime) spec.onAddAnnotation = opts.onPickTime;
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
    /* 계획을 세우기 전 잠긴 영역 — 보이되 누를 수 없다 */
    .exp1-locked { opacity: 0.45; filter: grayscale(0.4); }
    .exp1-lockmsg { margin: 4px 2px; color: #b45309; font-size: 15px; }
    /* 사건 메모선 입력칸·목록 */
    .exp1-anno-form { border: 1px solid #fca5a5; background: #fef2f2; border-radius: 8px; padding: 8px 12px; margin: 6px 0; }
    .exp1-anno-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
    .exp1-anno-row input { flex: 1 1 180px; padding: 4px 8px; }
    .exp1-anno-ul { list-style: none; padding: 0; margin: 4px 0; }
    .exp1-anno-ul li { padding: 3px 0; border-bottom: 1px dashed #eee; }
    .exp1-anno-ul li b { color: #dc2626; }
    .exp1-ghost { background: none; border: 1px solid #ccc; border-radius: 6px; color: #555; font-size: 13px; padding: 2px 8px; margin-left: 6px; cursor: pointer; }
  `;
  document.head.append(style);
}
