// js/teacher-tabs.js — 교사 대시보드 탭 4개의 화면 렌더링 (세션 E)
//
// teacher.js(로그인·학급 선택·학급 만들기·탭 전환)에서 분리했다.
// 각 render*Tab(cls) 함수는 currentClass 객체(teacher.js가 들고 있는 참조)를 받아 그린다.
// cls의 속성을 직접 바꾸면(activeExp 등) teacher.js 쪽 currentClass에도 그대로 반영된다(같은 객체 참조).

import { MODE } from "./data.js";
import { renderChart } from "./chart-kit.js";
import {
  fetchClassDatasets, fetchAnalysis, deleteDatasetDoc,
  setActiveExpField, setVisibleExpsField, getVisibleExps,
} from "./teacher-data.js";

const TOTAL_STEPS = 5; // §8 분석 단계는 5단계
const EXP_LABELS = { 1: "환기 주기", 2: "식물 광합성", 3: "운동과 몸", 4: "비열(물·식용유)" };

function groupLabel(groupId) {
  return (groupId || "").replace(/^g/, "") + "모둠";
}

function notice(text) {
  const box = document.createElement("div");
  box.className = "th-notice";
  box.textContent = text;
  return box;
}

// ── 1. 모둠별 진행 현황 ──────────────────────────────────

export async function renderProgressTab(cls) {
  const el = document.getElementById("tab-progress");
  el.innerHTML = "";
  if (MODE === "mock") el.append(notice("🧪 지금은 연습 모드예요. 가짜 데이터로 보여줘요."));

  const loading = document.createElement("p");
  loading.textContent = "불러오는 중…";
  el.append(loading);

  const perExp = await Promise.all([1, 2, 3].map(async (expNo) => {
    const datasets = await fetchClassDatasets(cls.id, expNo);
    const groupIds = [...new Set(datasets.map((d) => d.groupId))];
    const counts = {};
    datasets.forEach((d) => { counts[d.groupId] = (counts[d.groupId] || 0) + 1; });
    const analyses = {};
    await Promise.all(groupIds.map(async (gid) => {
      analyses[gid] = await fetchAnalysis(cls.id, expNo, gid);
    }));
    return { expNo, groupIds, counts, analyses };
  }));

  const allGroupIds = [...new Set(perExp.flatMap((e) => e.groupIds))].sort();
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
        ${[1, 2, 3].map((n) => `<th colspan="3">실험 ${n} · ${EXP_LABELS[n]}</th>`).join("")}
      </tr>
      <tr>
        ${[1, 2, 3].map(() => `<th>측정</th><th>진도</th><th>결론</th>`).join("")}
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  allGroupIds.forEach((gid) => {
    const tr = document.createElement("tr");
    let cells = `<td class="group-name">${groupLabel(gid)}</td>`;
    perExp.forEach(({ counts, analyses }) => {
      const count = counts[gid] || 0;
      const analysis = analyses[gid];
      const answered = analysis ? Object.values(analysis.answers || {}).filter((a) => (a || "").trim?.()).length : 0;
      const hasConclusion = !!analysis?.conclusion?.trim?.();
      const stepClass = answered === 0 ? "none" : answered >= TOTAL_STEPS ? "done" : "doing";
      cells += `
        <td>${count ? count + "건" : "—"}</td>
        <td><span class="step-badge ${stepClass}">${answered}/${TOTAL_STEPS}</span></td>
        <td>${hasConclusion ? "✅" : "—"}</td>
      `;
    });
    tr.innerHTML = cells;
    tbody.append(tr);
  });

  el.append(table);
}

// ── 2. 학급 종합 그래프 ──────────────────────────────────

export async function renderChartTab(cls) {
  const el = document.getElementById("tab-chart");
  el.innerHTML = "";

  const toolbar = document.createElement("div");
  toolbar.className = "th-toolbar";
  toolbar.innerHTML = `
    <label for="chart-exp-select">실험 선택</label>
    <select id="chart-exp-select">
      <option value="1">실험 1 · 환기 주기</option>
      <option value="2">실험 2 · 식물 광합성</option>
      <option value="3">실험 3 · 운동과 몸</option>
    </select>
  `;
  el.append(toolbar);

  const chartWrap = document.createElement("div");
  chartWrap.className = "chart-wrap";
  const canvas = document.createElement("canvas");
  chartWrap.append(canvas);
  el.append(chartWrap);

  const select = toolbar.querySelector("#chart-exp-select");
  const draw = async () => {
    const expNo = Number(select.value);
    const datasets = await fetchClassDatasets(cls.id, expNo);
    if (datasets.length === 0) {
      chartWrap.innerHTML = `<p style="color:var(--dim)">아직 이 실험에 측정된 데이터가 없어요.</p>`;
      return;
    }
    chartWrap.innerHTML = "";
    chartWrap.append(canvas);
    // 모둠마다 가장 최근 측정 1개씩만 겹쳐 그린다
    const latestByGroup = new Map();
    datasets.forEach((d) => {
      const prev = latestByGroup.get(d.groupId);
      const t = d.startedAt?.toDate ? d.startedAt.toDate().getTime() : new Date(d.startedAt).getTime();
      if (!prev || t > prev._t) latestByGroup.set(d.groupId, { ...d, _t: t });
    });
    const first = [...latestByGroup.values()][0];
    renderChart(canvas, {
      type: "line",
      datasets: [...latestByGroup.entries()].map(([gid, d]) => ({
        label: groupLabel(gid), points: d.points || [],
      })),
      xLabel: "시간(분)",
      yLabel: `${first.sensor} (${first.unit})`,
      tooltip: { timeFormat: "mmss", valueLabel: first.sensor, valueUnit: first.unit },
    });
  };
  select.addEventListener("change", draw);
  await draw();
}

// ── 3. 데이터 관리 ───────────────────────────────────────

export async function renderManageTab(cls) {
  const el = document.getElementById("tab-manage");
  el.innerHTML = "";

  const activeBox = document.createElement("div");
  activeBox.className = "th-toolbar";
  activeBox.innerHTML = `<label>지금 진행 중인 실험</label>`;
  [1, 2, 3].forEach((n) => {
    const btn = document.createElement("button");
    btn.className = "btn small" + (cls.activeExp === n ? "" : " ghost");
    btn.textContent = `실험 ${n}로 전환`;
    btn.addEventListener("click", async () => {
      await setActiveExpField(cls.id, n);
      cls.activeExp = n;
      await renderManageTab(cls);
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
      await renderManageTab(cls);
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

  const all = (await Promise.all([1, 2, 3].map((n) => fetchClassDatasets(cls.id, n)))).flat();
  if (all.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">아직 측정된 데이터가 없어요.</td></tr>`;
    return;
  }
  all.forEach((d) => {
    const tr = document.createElement("tr");
    const when = d.startedAt?.toDate ? d.startedAt.toDate() : new Date(d.startedAt);
    tr.innerHTML = `
      <td>실험 ${d.expNo}</td>
      <td>${groupLabel(d.groupId)}</td>
      <td>${d.title || "(제목 없음)"}</td>
      <td>${isNaN(when) ? "—" : when.toLocaleString("ko-KR")}</td>
      <td>${d.points?.length ?? 0}</td>
      <td><button class="btn tiny ghost">삭제</button></td>
    `;
    tr.querySelector("button").addEventListener("click", async () => {
      if (!confirm("이 측정을 지울까요? 되돌릴 수 없어요.")) return;
      await deleteDatasetDoc(cls.id, d.id);
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
    <h1>${cls.name || "우리 반"} · 지금 실험 ${cls.activeExp ?? "—"}</h1>
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
          <div class="tv-group">${groupLabel(gid)}</div>
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

  await refresh();
  tvTimer = setInterval(refresh, 30000); // 30초마다 갱신
}
