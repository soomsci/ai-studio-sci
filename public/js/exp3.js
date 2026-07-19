// js/exp3.js — 실험 3 "운동과 우리 몸" 탭 (세션 D)
//
// 화면 구성 (위 → 아래):
//   ① 탐구 질문 헤더 + 모둠별 주제 선택(§10.3) — 주제를 고르기 전엔 아래가 안 보인다
//   ② 우리 모둠 측정 목록 + 연습 데이터 만들기 + 분석에 쓸 측정 고르기 (exp1과 동일 패턴)
//   ③ 분석 5단계 (steps.js의 renderSteps) — 주제에 따라 산점도/선그래프로 갈라진다
//
// 주제①(운동 강도-심박수)은 측정 1건 = 점 1개인 산점도, 주제②(회복 속도)는
// exp1과 같은 선그래프다. 기준선 대신 "학급 평균선"을 쓰고(§10.3), 산점도에는
// 학급 전체를 익명으로 겹쳐 보는 토글이 있다(절대 규칙 2·3 — 모둠 단위로만 비교).
//
// 문구·질문·그래프 설정은 전부 config/exp3.config.js에 있다.

import { EXP3, TOPICS } from "../config/exp3.config.js";
import { listDatasets, listClassDatasets, saveDataset, getAnalysis, saveAnalysis } from "./data.js";
import { renderChart } from "./chart-kit.js";
import { renderSteps } from "./steps.js";
import { getSession } from "./auth.js";

// 탭이 열려 있는 동안의 상태
let rootEl = null;
let session = null;
let datasets = [];
let analysis = null;
let slots = {};   // 단계별 render 훅이 그린 자리 — 측정 선택이 바뀌면 다시 그린다

// ── 탭 진입점 (router.js 규약) ─────────────────────────────
export async function mount(containerEl) {
  rootEl = containerEl;
  session = getSession();
  slots = {};
  injectStyle();

  containerEl.innerHTML = `
    <section class="exp3-header">
      <h2>🏃 실험 3 — ${EXP3.title}</h2>
      <p class="exp3-help">모둠마다 다른 질문을 골라 탐구해요. 먼저 우리 모둠이 살펴볼 주제를 정해 주세요.</p>
      <div id="exp3-topic"></div>
    </section>

    <div id="exp3-body"></div>
  `;

  await reload();
}

// 분석 문서를 불러와 화면을 채운다
async function reload() {
  analysis = await getAnalysis(EXP3.expNo, session.groupId);
  analysis.expNo = EXP3.expNo;
  analysis.groupId = session.groupId;
  analysis.chartOptions = analysis.chartOptions || {};

  renderTopicPicker(rootEl.querySelector("#exp3-topic"));
  await renderBody();
}

// ── ① 모둠별 주제 선택 ──────────────────────────────────────
function renderTopicPicker(el) {
  const current = analysis.chartOptions.topic || "";
  el.innerHTML = `
    <select id="exp3-topic-select">
      <option value="" ${current ? "" : "selected"}>주제를 골라 주세요</option>
      ${TOPICS.map(
        (t) =>
          `<option value="${t.id}" ${t.id === current ? "selected" : ""} ${t.ready ? "" : "disabled"}>
            ${t.num}. ${t.label}${t.ready ? "" : " (센서 준비 중)"}
          </option>`
      ).join("")}
    </select>
    ${current && !TOPICS.find((t) => t.id === current)?.ready ? "" : ""}
  `;
  el.querySelector("#exp3-topic-select").addEventListener("change", async (e) => {
    analysis.chartOptions.topic = e.target.value;
    await saveAnalysis(analysis);
    await renderBody();
  });
}

// 지금 고른 주제의 config 조각 ({ xLabel, yLabel, tooltip, stats, steps, chartMode })
function currentTopicConfig() {
  const id = analysis.chartOptions.topic;
  if (!id) return null;
  const meta = TOPICS.find((t) => t.id === id);
  if (!meta || !meta.ready) return null;
  return { ...meta, ...EXP3[id] };
}

// ── ② + ③ 주제를 고른 뒤에만 보이는 본문 ─────────────────────
async function renderBody() {
  const bodyEl = rootEl.querySelector("#exp3-body");
  const topic = currentTopicConfig();

  if (!topic) {
    bodyEl.innerHTML = `<p class="exp3-dim">위에서 주제를 먼저 골라 주세요.</p>`;
    return;
  }

  bodyEl.innerHTML = `
    <p class="exp3-question">탐구 질문: <strong>${topic.question}</strong></p>

    <section class="exp3-box">
      <h3>우리 모둠의 측정</h3>
      <p class="exp3-help">분석에 쓸 측정을 골라 주세요.</p>
      <div id="exp3-list"><p class="exp3-dim">측정 목록을 불러오는 중…</p></div>
      <div class="exp3-practice">
        <label>아직 센서가 없다면 —
          <select id="exp3-cond">
            ${EXP3.conditions.map((c) => `<option>${c}</option>`).join("")}
          </select>
        </label>
        <button id="exp3-make">연습 데이터 만들기</button>
        <span id="exp3-make-msg" class="exp3-dim"></span>
      </div>
    </section>

    <section id="exp3-steps"></section>
  `;

  bodyEl.querySelector("#exp3-make").addEventListener("click", () => onMakePractice(topic));
  await reloadDatasets(topic);
}

// 측정 목록을 불러와 목록 + 단계를 그린다
async function reloadDatasets(topic) {
  datasets = await listDatasets(EXP3.expNo, session.groupId);

  const ids = datasets.map((d) => d.id);
  let picked = (analysis.datasetIds || []).filter((id) => ids.includes(id));
  if (!picked.length) picked = [...ids];
  analysis.datasetIds = picked;

  renderDatasetList(rootEl.querySelector("#exp3-list"), topic);
  renderSteps(rootEl.querySelector("#exp3-steps"), buildSteps(topic), analysis, saveAnalysis);
}

function pickedDatasets() {
  return datasets.filter((d) => analysis.datasetIds.includes(d.id));
}

// ── 측정 목록 (체크박스) — exp1과 동일한 패턴 ─────────────────
function renderDatasetList(listEl, topic) {
  if (!datasets.length) {
    listEl.innerHTML = `<p class="exp3-dim">아직 측정이 없어요. 아래에서 연습 데이터를 만들어 보세요.</p>`;
    return;
  }
  listEl.innerHTML = datasets
    .map((d) => {
      const checked = analysis.datasetIds.includes(d.id) ? "checked" : "";
      return `<label class="exp3-item">
        <input type="checkbox" data-id="${d.id}" ${checked}>
        <b>${d.title}</b>
        <span class="exp3-dim">${d.condition} · ${d.points.length}개 점${d.source === "mock" ? " · 연습" : ""}</span>
      </label>`;
    })
    .join("");

  listEl.querySelectorAll("input[type=checkbox]").forEach((box) => {
    box.addEventListener("change", async () => {
      const id = box.dataset.id;
      analysis.datasetIds = box.checked
        ? [...analysis.datasetIds, id]
        : analysis.datasetIds.filter((x) => x !== id);
      await saveAnalysis(analysis);
      refreshSlots(topic); // 열려 있는 단계의 그래프·표를 새로 그린다
    });
  });
}

// "연습 데이터 만들기" — generateMock으로 가짜 측정을 만들어 저장한다 (exp1과 동일 패턴)
async function onMakePractice(topic) {
  const msgEl = rootEl.querySelector("#exp3-make-msg");
  const cond = rootEl.querySelector("#exp3-cond").value;
  try {
    msgEl.textContent = "만드는 중…";
    const { generateMock } = await import("../mock/mock-data.js");
    const ds = generateMock(EXP3.expNo, cond);
    ds.groupId = session.groupId;
    await saveDataset(ds);
    msgEl.textContent = "";
    await reloadDatasets(topic);
  } catch (e) {
    console.error(e);
    msgEl.textContent = "연습 데이터를 만들지 못했어요. 선생님께 알려 주세요.";
  }
}

// ── 분석 5단계 — 주제별 steps에 render 훅을 끼운다 ──────────
function buildSteps(topic) {
  const hooks = { s2: renderStep2Chart, s3: renderStep3Chart };
  return topic.steps.map((step) => {
    const hook = hooks[step.id];
    if (!hook) return step; // 1·4·5단계는 글로만 답한다
    return {
      ...step,
      render: (slotEl) => {
        slots[step.id] = slotEl;
        hook(slotEl, topic);
      },
    };
  });
}

// 측정 선택이 바뀌었을 때, 이미 그려져 있는 단계 내용을 다시 그린다
function refreshSlots(topic) {
  const hooks = { s2: renderStep2Chart, s3: renderStep3Chart };
  for (const [id, el] of Object.entries(slots)) {
    if (el.isConnected) hooks[id](el, topic);
  }
}

// 2단계: 그래프 + "학급과 비교해서 보기" 토글
// (exp1과 달리 그래프 종류는 고르지 않는다 — 주제마다 산점도/선그래프가 이미 정해져 있다)
function renderStep2Chart(slotEl, topic) {
  const opts = analysis.chartOptions;
  if (opts.showClass === undefined) opts.showClass = true;

  slotEl.innerHTML = `
    <label class="exp3-toggle">
      <input type="checkbox" id="exp3-classtoggle" ${opts.showClass ? "checked" : ""}>
      학급 전체와 비교해서 보기 (다른 모둠은 익명으로 표시돼요)
    </label>
    <div class="exp3-chartbox"><canvas></canvas></div>
  `;

  slotEl.querySelector("#exp3-classtoggle").addEventListener("change", async (e) => {
    opts.showClass = e.target.checked;
    await saveAnalysis(analysis);
    draw();
  });

  const draw = () => drawChart(slotEl.querySelector("canvas"), topic, opts);
  draw();
}

// 3단계: 그래프(좌표 확인용, 항상 학급 비교 포함) + 자동 계산 표
function renderStep3Chart(slotEl, topic) {
  slotEl.innerHTML = `
    <div class="exp3-chartbox"><canvas></canvas></div>
    <div id="exp3-stats"></div>
  `;
  drawChart(slotEl.querySelector("canvas"), topic, { ...analysis.chartOptions, showClass: true });

  const picked = pickedDatasets();
  const statsEl = slotEl.querySelector("#exp3-stats");
  if (!picked.length) {
    statsEl.innerHTML = `<p class="exp3-dim">위에서 측정을 골라 주세요.</p>`;
    return;
  }
  // 자동 계산: 숫자만 보여준다. 해석은 학생 몫 (SPEC §8.4)
  const head = topic.stats.map((s) => `<th>${s.label}</th>`).join("");
  const rows = picked
    .map((d) => {
      const st = topic.chartMode === "scatter" ? computeStatsIntensity(d) : computeStatsRecovery(d, topic);
      const cells = topic.stats.map((s) => `<td>${st[s.key] ?? "—"}</td>`).join("");
      return `<tr><td>${d.title}</td>${cells}</tr>`;
    })
    .join("");
  statsEl.innerHTML = `<p class="exp3-help">자동 계산 — 내가 그래프에서 짚은 값과 비교해 보세요.</p>
    <table class="exp3-table"><thead><tr><th>측정</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// 고른 측정들을 그린다. 주제에 따라 산점도/선그래프로 갈라진다.
async function drawChart(canvasEl, topic, opts) {
  const picked = pickedDatasets();
  if (!picked.length) {
    canvasEl.replaceWith(Object.assign(document.createElement("p"), {
      className: "exp3-dim", textContent: "위에서 측정을 골라 주세요.",
    }));
    return;
  }
  if (topic.chartMode === "scatter") await drawScatterChart(canvasEl, topic, opts, picked);
  else await drawLineChart(canvasEl, topic, opts, picked);
}

// ── 주제① 산점도: 운동 강도 → 최고 심박수 ───────────────────
// 측정 1건 = 점 1개. x는 조건에서 뽑은 운동 강도 단계, y는 그 측정의 최고 심박수.
async function drawScatterChart(canvasEl, topic, opts, picked) {
  const ours = picked
    .map((d) => ({ x: EXP3.intensityStep[d.condition], y: peakValue(d) }))
    .filter((p) => p.x != null);

  const spec = {
    type: "scatter",
    xLabel: topic.xLabel,
    yLabel: topic.yLabel,
    tooltip: topic.tooltip,
    datasets: [{ label: "우리 모둠", points: ours, color: "#2563eb" }],
  };

  if (opts.showClass) {
    const classDatasets = await listClassDatasets(EXP3.expNo);
    if (!canvasEl.isConnected) return; // 그리는 사이 화면이 바뀌었으면 그만둔다
    const others = classDatasets.filter(
      (d) => d.groupId !== session.groupId && EXP3.intensityStep[d.condition] != null
    );
    const otherPoints = others.map((d) => ({ x: EXP3.intensityStep[d.condition], y: peakValue(d) }));
    if (otherPoints.length) {
      spec.datasets.unshift({ label: "다른 모둠", points: otherPoints, color: "#cbd5e1" });
    }
    const allY = [...ours, ...otherPoints].map((p) => p.y);
    if (allY.length) {
      spec.refLine = { value: avg(allY), label: "학급 평균", color: EXP3.classAvgColor };
    }
  } else if (!canvasEl.isConnected) {
    return;
  }

  renderChart(canvasEl, spec);
}

// ── 주제② 선그래프: 심박수 회복 곡선 ─────────────────────────
async function drawLineChart(canvasEl, topic, opts, picked) {
  const spec = {
    type: "line",
    xLabel: topic.xLabel,
    yLabel: topic.yLabel,
    tooltip: topic.tooltip,
    datasets: picked.map((d) => ({ label: d.title, points: d.points })),
    events: picked.flatMap((d) => d.events || []),
  };

  if (opts.showClass) {
    const classDatasets = await listClassDatasets(EXP3.expNo);
    if (!canvasEl.isConnected) return;
    // 회복 곡선과 비교할 값이므로 운동 조건만 모아 "학급 평균 최고 심박수"를 계산한다
    const exercised = classDatasets.filter((d) => d.condition === "가벼운 운동 후" || d.condition === "심한 운동 후");
    if (exercised.length) {
      spec.refLine = { value: avg(exercised.map(peakValue)), label: "학급 평균 최고 심박수", color: EXP3.classAvgColor };
    }
  } else if (!canvasEl.isConnected) {
    return;
  }

  renderChart(canvasEl, spec);
}

// ── 자동 계산 ─────────────────────────────────────────────
function peakValue(d) {
  return Math.max(...d.points.map((p) => p.v));
}

// 마지막 seconds초 동안의 평균값 — "측정 끝 무렵" 수준을 어림한다
function tailAverage(points, seconds) {
  if (!points.length) return 0;
  const cut = points.at(-1).t - seconds;
  const tail = points.filter((p) => p.t >= cut);
  const use = tail.length ? tail : [points.at(-1)];
  return use.reduce((s, p) => s + p.v, 0) / use.length;
}

function avg(nums) {
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

// 주제①: 최고 심박수 / 측정 끝 무렵 심박수(안정 수준)
function computeStatsIntensity(d) {
  return {
    peak: fmtV(peakValue(d), d.unit),
    restBase: fmtV(tailAverage(d.points, 60), d.unit),
  };
}

// 주제②: 최고 심박수 / 기저 수준(±여유값)까지 돌아오는 데 걸린 시간
function computeStatsRecovery(d, topic) {
  const baseline = tailAverage(d.points, 30);
  const target = baseline + (topic.recoverMargin ?? 3);
  const recovered = d.points.find((p) => p.v <= target);
  return {
    peak: fmtV(peakValue(d), d.unit),
    recoverTime: recovered ? fmtTime(recovered.t) : "측정 시간 안에 못 돌아옴",
  };
}

// 초 → "2분 05초" (툴팁과 같은 형식이라 학생이 대조하기 쉽다)
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}분 ${String(s).padStart(2, "0")}초`;
}

// 값 + 단위 (예: "132.4 bpm")
function fmtV(v, unit) {
  return `${Math.round(v * 10) / 10} ${unit || "bpm"}`;
}

// ── 이 탭에서만 쓰는 최소 스타일 ──────────────────────────
function injectStyle() {
  if (document.getElementById("exp3-style")) return;
  const style = document.createElement("style");
  style.id = "exp3-style";
  style.textContent = `
    .exp3-header h2 { margin-bottom: 4px; }
    .exp3-help, .exp3-dim { color: #777; font-size: 14px; }
    .exp3-question { color: #444; margin: 8px 0; }
    .exp3-box { border: 1px solid #ddd; border-radius: 10px; padding: 12px 16px; margin: 12px 0; }
    .exp3-item { display: block; padding: 4px 0; cursor: pointer; }
    .exp3-item input { margin-right: 6px; }
    .exp3-practice { margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .exp3-chartbox { position: relative; height: 320px; margin: 8px 0; }
    .exp3-toggle { display: block; font-size: 14px; margin-bottom: 4px; cursor: pointer; }
    .exp3-toggle input { margin-right: 6px; }
    .exp3-table { border-collapse: collapse; font-size: 14px; margin: 8px 0; width: 100%; }
    .exp3-table th, .exp3-table td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
    .exp3-table th { background: #f6f7f9; }
    #exp3-topic-select { font-size: 14px; padding: 4px 6px; margin-top: 6px; }
  `;
  document.head.append(style);
}
