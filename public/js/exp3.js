// js/exp3.js — 실험 3 "운동과 우리 몸" 탭 (세션 D)
//
// 화면 구성 (위 → 아래):
//   ① 탐구 질문 헤더 + 모둠별 주제 선택(§10.3) — 주제를 고르기 전엔 아래가 안 보인다
//   ② 우리 모둠 측정 목록 + 연습 데이터 만들기 + 분석에 쓸 측정 고르기 (exp1과 동일 패턴)
//   ③ 분석 5단계 (steps.js의 renderSteps) — 주제에 따라 산점도/선그래프로 갈라진다
//
// 지금 이 파일은 "화면 골격" 단계다. 그래프·자동 계산·학급 분포 비교는
// 다음 단계(기능 연결)에서 채운다. 여기서는 자리만 잡아 둔다.
//
// 문구·질문·그래프 설정은 전부 config/exp3.config.js에 있다.

import { EXP3, TOPICS } from "../config/exp3.config.js";
import { listDatasets, saveDataset, getAnalysis, saveAnalysis } from "./data.js";
import { renderSteps } from "./steps.js";
import { getSession } from "./auth.js";

// 탭이 열려 있는 동안의 상태
let rootEl = null;
let session = null;
let datasets = [];
let analysis = null;

// ── 탭 진입점 (router.js 규약) ─────────────────────────────
export async function mount(containerEl) {
  rootEl = containerEl;
  session = getSession();
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
      // 골격 단계: 단계 안 그래프 다시 그리기는 다음 단계(기능 연결)에서 채운다
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

// ── 분석 5단계 — 주제별 steps에 render 훅 자리만 끼운다 (골격 단계) ──
function buildSteps(topic) {
  const hooks = {
    s2: (slotEl) => renderPlaceholderChart(slotEl, topic),
    s3: (slotEl) => renderPlaceholderChart(slotEl, topic),
  };
  return topic.steps.map((step) => {
    const hook = hooks[step.id];
    if (!hook) return step; // 1·4·5단계는 글로만 답한다
    return { ...step, render: hook };
  });
}

// 그래프·자동 계산 자리 — 다음 단계(기능 연결)에서 chart-kit.renderChart로 채운다
function renderPlaceholderChart(slotEl, topic) {
  const kind = topic.chartMode === "scatter" ? "산점도" : "선그래프(회복 곡선)";
  slotEl.innerHTML = `
    <div class="exp3-chartbox exp3-placeholder">
      <p class="exp3-dim">${kind} 자리 — 다음 단계에서 실제 그래프를 연결해요.</p>
    </div>
    <div class="exp3-dim">자동 계산 표 자리 — 다음 단계에서 연결해요.</div>
  `;
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
    .exp3-chartbox { position: relative; min-height: 200px; margin: 8px 0; display: flex; align-items: center; justify-content: center; }
    .exp3-placeholder { border: 1px dashed #ccc; border-radius: 8px; }
    #exp3-topic-select { font-size: 14px; padding: 4px 6px; margin-top: 6px; }
  `;
  document.head.append(style);
}
