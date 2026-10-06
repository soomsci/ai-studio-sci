// js/teacher-tabs.js — 교사 대시보드 탭 4개의 화면 렌더링 (세션 E)
//
// teacher.js(로그인·학급 선택·학급 만들기·탭 전환)에서 분리했다.
// 각 render*Tab(cls) 함수는 currentClass 객체(teacher.js가 들고 있는 참조)를 받아 그린다.
// cls의 속성을 직접 바꾸면(activeExp 등) teacher.js 쪽 currentClass에도 그대로 반영된다(같은 객체 참조).

import { MODE } from "./data.js";
import { renderChart } from "./chart-kit.js";
import {
  fetchClassDatasets, fetchAnalysis, fetchAllAnalyses, deleteDatasetDoc,
  setActiveExpField, setVisibleExpsField, getVisibleExps,
} from "./teacher-data.js";

import { escapeText } from "./utils.js";
import { stepComplete } from "./steps.js";
import { EXP1 } from "../config/exp1.config.js";
import { EXP2 } from "../config/exp2.config.js";
import { EXP3 } from "../config/exp3.config.js";
import { EXP4 } from "../config/exp4.config.js";

export function analysisProgress(expNo, analysis = {}) {
  const config = { 1: EXP1, 2: EXP2, 3: EXP3, 4: EXP4 }[expNo];
  const topic = expNo === 3 ? EXP3[analysis.chartOptions?.topic] : null;
  const steps = topic?.steps || config?.steps || [];
  const plan = expNo === 3
    ? [...EXP3.designStepsCommon, ...(topic ? [topic.designStepExtra] : [])]
    : config?.designSteps || [];
  const count = (list) => list.filter((step) => stepComplete(step, analysis)).length;
  const writing = steps.filter((step) => step.type !== "choice");
  const gates = steps.filter((step) => step.type === "choice");
  return { answered: count(writing), total: writing.length,
    plan: count(plan), planTotal: plan.length, gates: count(gates), gateTotal: gates.length };
}

const renderVersions = {};
function beginRender(name) {
  const version = (renderVersions[name] || 0) + 1;
  renderVersions[name] = version;
  return () => renderVersions[name] === version;
}

const EXP_LABELS = { 1: "환기 주기", 2: "식물 광합성", 3: "운동과 몸", 4: "비열(물·식용유)" };
const EXP_NUMS = Object.keys(EXP_LABELS).map(Number); // [1,2,3,4] — 하드코딩 대신 여기서 파생

function groupLabel(groupId) {
  return (groupId || "").replace(/^g/, "") + "모둠";
}

// ── 탭 간 측정 목록 캐시 ──────────────────────────────────
// 학급 하나를 보는 동안 progress·chart·manage 탭이 같은 fetchClassDatasets(classId, expNo)를
// 중복 호출하지 않도록 여기서 한 번만 받아 나눠 쓴다. 학급을 바꾸면 자동으로 비워진다.
// 실시간 뷰(TV)는 라이브 갱신이 목적이라 이 캐시를 쓰지 않는다(아래 openTvView 참고).
let cachedClassId = null;
let datasetsCache = new Map(); // expNo -> Promise<datasets>

function getDatasets(classId, expNo) {
  if (cachedClassId !== classId) {
    datasetsCache.clear();
    cachedClassId = classId;
  }
  if (!datasetsCache.has(expNo)) {
    const promise = fetchClassDatasets(classId, expNo).catch((error) => {
      if (cachedClassId === classId && datasetsCache.get(expNo) === promise) datasetsCache.delete(expNo);
      throw error;
    });
    datasetsCache.set(expNo, promise);
  }
  return datasetsCache.get(expNo);
}

export function invalidateDatasetsCache() {
  datasetsCache.clear();
}

function notice(text) {
  const box = document.createElement("div");
  box.className = "th-notice";
  box.textContent = text;
  return box;
}

// ── 1. 모둠별 진행 현황 ──────────────────────────────────

export async function renderProgressTab(cls) {
  const isCurrent = beginRender("progress");
  const el = document.getElementById("tab-progress");
  el.innerHTML = "";
  if (MODE === "mock") el.append(notice("🧪 지금은 연습 모드예요. 가짜 데이터로 보여줘요."));

  const loading = document.createElement("p");
  loading.textContent = "불러오는 중…";
  el.append(loading);

  // 분석 문서는 모둠×실험마다 따로 읽지 않고 classes/{classId}/analyses 컬렉션을 한 번에 읽는다.
  // 연습 모드는 컬렉션 조회가 없어 null이 오고, 그때는 기존처럼 건별로 fetchAnalysis를 쓴다.
  const allAnalyses = await fetchAllAnalyses(cls.id);
  if (!isCurrent()) return;

  const perExp = await Promise.all(EXP_NUMS.map(async (expNo) => {
    const datasets = await getDatasets(cls.id, expNo);
    const groupIds = [...new Set([
      ...datasets.map((d) => d.groupId),
      ...Object.values(allAnalyses || {}).filter((a) => a.expNo === expNo).map((a) => a.groupId),
    ])];
    const counts = {};
    datasets.forEach((d) => { counts[d.groupId] = (counts[d.groupId] || 0) + 1; });
    const analyses = {};
    await Promise.all(groupIds.map(async (gid) => {
      analyses[gid] = allAnalyses
        ? (allAnalyses[`exp${expNo}_${gid}`] || { answers: {}, conclusion: "" })
        : await fetchAnalysis(cls.id, expNo, gid);
    }));
    return { expNo, groupIds, counts, analyses };
  }));

  const allGroupIds = [...new Set(perExp.flatMap((e) => e.groupIds))].sort();
  if (!isCurrent()) return;
  loading.remove();

  if (allGroupIds.length === 0) {
    el.append(notice("아직 어느 모둠도 측정을 시작하지 않았어요."));
    return;
  }

  const table = document.createElement("table");
  table.className = "progress-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th rowspan="2">모둠</th>
        ${EXP_NUMS.map((n) => `<th colspan="3">실험 ${n} · ${EXP_LABELS[n]}</th>`).join("")}
      </tr>
      <tr>
        ${EXP_NUMS.map(() => `<th>측정</th><th>진도</th><th>결론</th>`).join("")}
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  allGroupIds.forEach((gid) => {
    const tr = document.createElement("tr");
    let cells = `<td class="group-name">${escapeText(groupLabel(gid))}</td>`;
    perExp.forEach(({ expNo, counts, analyses }) => {
      const count = counts[gid] || 0;
      const analysis = analyses[gid];
      const { answered, total, plan, planTotal, gates, gateTotal } = analysisProgress(expNo, analysis);
      const hasConclusion = !!analysis?.conclusion?.trim?.();
      const stepClass = answered === 0 ? "none" : total > 0 && answered === total ? "done" : "doing";
      cells += `
        <td>${count ? count + "건" : "—"}</td>
        <td><span class="step-badge ${stepClass}">${total ? `${answered}/${total}` : "주제 선택 전"}</span><br><small>계획 ${plan}/${planTotal} · 축 선택 ${gates}/${gateTotal}</small></td>
        <td>${hasConclusion ? "✅" : "—"}</td>
      `;
    });
    tr.innerHTML = cells;
    tbody.append(tr);
  });

  el.append(table);
}

function sensorLabel(d) {
  const names = { CO2: "이산화 탄소", Temperature: "온도", HeartRate: "심박수", LungVolume: "폐활량",
    Light: "조도", Pressure: "압력", Current: "전류", Voltage: "전압" };
  return (names[d.sensor] || "측정값") + " (" + d.unit + ")";
}

// ── 2. 학급 종합 그래프 ──────────────────────────────────

export async function renderChartTab(cls) {
  const isCurrent = beginRender("chart");
  const el = document.getElementById("tab-chart");
  el.innerHTML = "";

  const toolbar = document.createElement("div");
  toolbar.className = "th-toolbar";
  toolbar.innerHTML = `
    <label for="chart-exp-select">실험 선택</label>
    <select id="chart-exp-select">
      ${EXP_NUMS.map((n) => `<option value="${n}">실험 ${n} · ${EXP_LABELS[n]}</option>`).join("")}
    </select>
    <label for="chart-sensor-select">측정값 종류</label>
    <select id="chart-sensor-select"></select>
  `;
  el.append(toolbar);
  const chartWrap = document.createElement("div");
  chartWrap.className = "chart-wrap";
  el.append(chartWrap);
  const select = toolbar.querySelector("#chart-exp-select");
  const sensorSelect = toolbar.querySelector("#chart-sensor-select");
  const sensorKey = (d) => JSON.stringify([d.sensor, d.unit]);
  let datasets = [];
  let request = 0;

  function draw() {
    if (!isCurrent()) return;
    chartWrap.replaceChildren();
    const matching = datasets.filter((d) => sensorKey(d) === sensorSelect.value);
    if (!matching.length) {
      const message = document.createElement("p");
      message.textContent = "아직 이 측정값이 없어요.";
      chartWrap.append(message);
      return;
    }
    const latestByGroup = new Map();
    matching.forEach((d) => {
      const prev = latestByGroup.get(d.groupId);
      const t = d.startedAt?.toDate ? d.startedAt.toDate().getTime() : new Date(d.startedAt).getTime();
      if (!prev || t > prev._t) latestByGroup.set(d.groupId, { ...d, _t: t });
    });
    const first = matching[0];
    const canvas = document.createElement("canvas");
    chartWrap.append(canvas);
    renderChart(canvas, {
      type: "line",
      datasets: [...latestByGroup.entries()].map(([gid, d]) => ({ label: groupLabel(gid), points: d.points || [] })),
      xLabel: "시간(분)", yLabel: sensorLabel(first),
      tooltip: { timeFormat: "mmss", valueLabel: sensorLabel(first), valueUnit: first.unit },
    });
  }

  async function load() {
    const version = ++request;
    const next = await getDatasets(cls.id, Number(select.value));
    if (!isCurrent() || version !== request) return;
    datasets = next;
    sensorSelect.replaceChildren();
    const kinds = new Map(datasets.map((d) => [sensorKey(d), d]));
    for (const [key, d] of kinds) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = sensorLabel(d);
      sensorSelect.append(option);
    }
    draw();
  }
  sensorSelect.addEventListener("change", draw);
  select.addEventListener("change", () => {
    const loading = load();
    const version = request;
    loading.catch(() => {
      if (isCurrent() && version === request) chartWrap.textContent = "불러오지 못했어요. 새로고침해 주세요.";
    });
  });
  await load();
}

// ── 3. 데이터 관리 ───────────────────────────────────────

export async function renderManageTab(cls) {
  const isCurrent = beginRender("manage");
  const el = document.getElementById("tab-manage");
  el.innerHTML = "";

  const activeBox = document.createElement("div");
  activeBox.className = "th-toolbar";
  activeBox.innerHTML = `<label>지금 진행 중인 실험</label>`;
  EXP_NUMS.forEach((n) => {
    const btn = document.createElement("button");
    btn.className = "btn small" + (cls.activeExp === n ? "" : " ghost");
    btn.textContent = `실험 ${n}로 전환`;
    btn.addEventListener("click", async () => {
      await setActiveExpField(cls.id, n);
      cls.activeExp = n;
      if (isCurrent()) await renderManageTab(cls);
    });
    activeBox.append(btn);
  });
  el.append(activeBox);

  // 실험 탭 표시/숨김 (v2.0) — activeExp("지금 하는 실험")와는 다른 설정이다.
  // 여기서 끈 실험은 학생 화면(index.html)의 탭 목록에서 아예 안 보인다.
  const visibleBox = document.createElement("div");
  visibleBox.className = "th-toolbar";
  visibleBox.innerHTML = `<label>학생 화면에 보이는 실험 탭</label>`;
  const visibleExps = getVisibleExps(cls);
  [1, 2, 3, 4].forEach((n) => {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:inline-flex; align-items:center; gap:6px; margin-right:14px; font-size:14px;";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = visibleExps.includes(n);
    checkbox.addEventListener("change", async () => {
      const next = checkbox.checked
        ? [...new Set([...getVisibleExps(cls), n])].sort()
        : getVisibleExps(cls).filter((v) => v !== n);
      await setVisibleExpsField(cls.id, next);
      cls.visibleExps = next;
      if (isCurrent()) await renderManageTab(cls);
    });
    const text = document.createElement("span");
    text.textContent = `실험 ${n} · ${EXP_LABELS[n]}` + (n === 4 ? " (추가 실험 · 기본 꺼짐)" : "");
    wrap.append(checkbox, text);
    visibleBox.append(wrap);
  });
  el.append(visibleBox);

  if (MODE === "mock") el.append(notice("🧪 연습 모드에서는 전환·삭제·표시 설정이 화면에만 반영되고 저장되지 않아요."));

  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead><tr><th>실험</th><th>모둠</th><th>제목</th><th>측정 시각</th><th>점 개수</th><th></th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  el.append(table);

  const all = (await Promise.all(EXP_NUMS.map((n) => getDatasets(cls.id, n)))).flat();
  if (!isCurrent()) return;
  if (all.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">아직 측정된 데이터가 없어요.</td></tr>`;
    return;
  }
  all.forEach((d) => {
    const tr = document.createElement("tr");
    const when = d.startedAt?.toDate ? d.startedAt.toDate() : new Date(d.startedAt);
    tr.innerHTML = `
      <td>실험 ${escapeText(d.expNo)}</td>
      <td>${escapeText(groupLabel(d.groupId))}</td>
      <td>${escapeText(d.title || "(제목 없음)")}</td>
      <td>${isNaN(when) ? "—" : when.toLocaleString("ko-KR")}</td>
      <td>${d.points?.length ?? 0}</td>
      <td><button class="btn tiny ghost">삭제</button></td>
    `;
    tr.querySelector("button").addEventListener("click", async () => {
      if (!confirm("이 측정을 지울까요? 되돌릴 수 없어요.")) return;
      await deleteDatasetDoc(cls.id, d.id);
      invalidateDatasetsCache(); // 지운 직후 옛 목록이 다른 탭에 남지 않게 비운다
      tr.remove();
    });
    tbody.append(tr);
  });
}

// ── 4. 교실 화면용 실시간 뷰 ─────────────────────────────

let tvTimer = null;

export async function renderTvTab(cls) {
  const el = document.getElementById("tab-tv");
  el.innerHTML = "";

  const enterBtn = document.createElement("button");
  enterBtn.className = "btn big";
  enterBtn.textContent = "교실 화면 모드로 보기 (전체화면)";
  enterBtn.addEventListener("click", () => openTvView(cls));
  el.append(enterBtn);
}

async function openTvView(cls) {
  const view = document.createElement("div");
  view.className = "tv-view";
  view.innerHTML = `
    <button class="btn ghost tv-exit">닫기</button>
    <h1>${escapeText(cls.name || "우리 반")} · 지금 실험 ${cls.activeExp ?? "—"}</h1>
    <div class="tv-grid"></div>
  `;
  document.body.append(view);
  view.querySelector(".tv-exit").addEventListener("click", closeTv);
  if (view.requestFullscreen) view.requestFullscreen().catch(() => {});

  async function refresh() {
    const expNo = cls.activeExp || 1;
    const datasets = await fetchClassDatasets(cls.id, expNo);
    const counts = {};
    datasets.forEach((d) => { counts[d.groupId] = (counts[d.groupId] || 0) + 1; });
    const grid = view.querySelector(".tv-grid");
    const groupIds = [...new Set(datasets.map((d) => d.groupId))].sort();
    grid.innerHTML = groupIds.length
      ? groupIds.map((gid) => `
        <div class="tv-card">
          <div class="tv-group">${escapeText(groupLabel(gid))}</div>
          <div class="tv-count">${counts[gid]}</div>
          <div class="tv-label">번 측정했어요</div>
        </div>
      `).join("")
      : `<p>아직 측정된 데이터가 없어요.</p>`;
  }

  function closeTv() {
    clearInterval(tvTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    view.remove();
  }

  const refreshSafely = () => refresh().catch(() => {
    if (view.isConnected) view.querySelector(".tv-grid").textContent = "불러오지 못했어요. 잠시 뒤 다시 확인할게요.";
  });
  await refreshSafely();
  if (view.isConnected) tvTimer = setInterval(refreshSafely, 30000); // 30초마다 갱신
}
