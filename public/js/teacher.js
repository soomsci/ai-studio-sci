// js/teacher.js — 선생님 대시보드 (세션 E)
//
// 구성 (SPEC §11 세션 E):
//   - Google 로그인
//   - 모둠별 진행 현황 (측정 건수·분석 단계 진도·결론 작성 여부)
//   - 학급 종합 그래프 (전 모둠 겹쳐 보기, chart-kit.js 재사용)
//   - 데이터 관리 (측정 삭제, activeExp 전환)
//   - 교실 화면용 실시간 뷰
//
// 주의: js/data.js의 함수들(listClassDatasets 등)은 "이 브라우저에 저장된 학생 세션의 classId"에
// 고정돼 있어 교사가 다른 classId를 볼 때는 못 쓴다. 아래 fetch*는 연습 모드에서 data.js를 재사용하고,
// 실제 Firebase 모드에서는 classId를 직접 받는 임시 구현이다 (세션 A에 정식 함수 추가 요청함 — 정리되면
// fetch*/deleteDatasetDoc/setActiveExpField 안쪽을 data.js 호출로 교체).

import { isConfigured, getFirebase } from "./firebase-init.js";
import { MODE, listClassDatasets, getAnalysis } from "./data.js";
import { renderChart } from "./chart-kit.js";

const TOTAL_STEPS = 5; // §8 분석 단계는 5단계
const EXP_LABELS = { 1: "환기 주기", 2: "식물 광합성", 3: "운동과 몸" };

let currentUser = null;
let myClasses = [];
let currentClass = null; // { id, name, activeExp, ... }

// ── 시작 ────────────────────────────────────────────────

if (!isConfigured) {
  // 연습 모드: 실제 로그인 없이 바로 대시보드로 들어간다 (다른 화면들의 연습 모드 관행과 동일)
  currentUser = { uid: "mock-teacher", email: "연습 모드" };
  enterDashboard();
} else {
  document.getElementById("google-login-btn").addEventListener("click", handleLogin);
  watchAuthState();
}

async function handleLogin() {
  const errBox = document.getElementById("login-error");
  errBox.style.display = "none";
  try {
    const { auth, authMod } = await getFirebase();
    const provider = new authMod.GoogleAuthProvider();
    const cred = await authMod.signInWithPopup(auth, provider);
    currentUser = cred.user;
  } catch (err) {
    console.error(err);
    errBox.textContent = "로그인에 실패했어요. 다시 시도해 주세요.";
    errBox.style.display = "block";
  }
}

function watchAuthState() {
  getFirebase().then(({ auth, authMod }) => {
    authMod.onAuthStateChanged(auth, (user) => {
      if (user) { currentUser = user; enterDashboard(); }
    });
  });
}

async function enterDashboard() {
  document.getElementById("login-gate").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  document.getElementById("teacher-label").textContent = currentUser.email || "";

  document.getElementById("logout-btn").addEventListener("click", async () => {
    if (isConfigured) {
      const { auth, authMod } = await getFirebase();
      await authMod.signOut(auth);
    }
    location.reload();
  });

  myClasses = await fetchMyClasses(currentUser.uid);
  const select = document.getElementById("class-select");
  select.innerHTML = "";
  if (myClasses.length === 0) {
    select.innerHTML = `<option>담당 학급이 없어요</option>`;
    return;
  }
  myClasses.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name || c.id;
    select.append(opt);
  });
  select.addEventListener("change", () => selectClass(select.value));

  // 탭 전환
  document.querySelectorAll(".th-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  await selectClass(myClasses[0].id);
}

async function selectClass(classId) {
  currentClass = myClasses.find((c) => c.id === classId) || { id: classId };
  await renderProgressTab();
  await renderChartTab();
  await renderManageTab();
  await renderTvTab();
}

function switchTab(name) {
  document.querySelectorAll(".th-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".th-section").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
}

// ── 데이터 조회 (임시 구현 — 위 안내 참고) ──────────────────

async function fsCtx() {
  const { db, fsMod } = await getFirebase();
  return { db, f: fsMod };
}

async function fetchMyClasses(uid) {
  if (MODE === "mock") return [{ id: "mock-class", name: "연습용 학급", activeExp: 1 }];
  const { db, f } = await fsCtx();
  const q = f.query(f.collection(db, "classes"), f.where("teacherUid", "==", uid));
  const snap = await f.getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchClassDatasets(classId, expNo) {
  if (MODE === "mock") return listClassDatasets(expNo);
  const { db, f } = await fsCtx();
  const q = f.query(f.collection(db, "classes", classId, "datasets"), f.where("expNo", "==", expNo));
  const snap = await f.getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchAnalysis(classId, expNo, groupId) {
  if (MODE === "mock") return getAnalysis(expNo, groupId);
  const { db, f } = await fsCtx();
  const snap = await f.getDoc(f.doc(db, "classes", classId, "analyses", `exp${expNo}_${groupId}`));
  return snap.exists() ? snap.data() : { answers: {}, conclusion: "" };
}

async function deleteDatasetDoc(classId, datasetId) {
  if (MODE === "mock") return; // 연습 모드는 실제로 지우지 않는다
  const { db, f } = await fsCtx();
  await f.deleteDoc(f.doc(db, "classes", classId, "datasets", datasetId));
}

async function setActiveExpField(classId, expNo) {
  if (MODE === "mock") { currentClass.activeExp = expNo; return; }
  const { db, f } = await fsCtx();
  await f.updateDoc(f.doc(db, "classes", classId), { activeExp: expNo });
  currentClass.activeExp = expNo;
}

function groupLabel(groupId) {
  return (groupId || "").replace(/^g/, "") + "모둠";
}

// ── 1. 모둠별 진행 현황 ──────────────────────────────────

async function renderProgressTab() {
  const el = document.getElementById("tab-progress");
  el.innerHTML = "";
  if (MODE === "mock") el.append(notice("🧪 지금은 연습 모드예요. 가짜 데이터로 보여줘요."));

  const loading = document.createElement("p");
  loading.textContent = "불러오는 중…";
  el.append(loading);

  const perExp = await Promise.all([1, 2, 3].map(async (expNo) => {
    const datasets = await fetchClassDatasets(currentClass.id, expNo);
    const groupIds = [...new Set(datasets.map((d) => d.groupId))];
    const counts = {};
    datasets.forEach((d) => { counts[d.groupId] = (counts[d.groupId] || 0) + 1; });
    const analyses = {};
    await Promise.all(groupIds.map(async (gid) => {
      analyses[gid] = await fetchAnalysis(currentClass.id, expNo, gid);
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

async function renderChartTab() {
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
    const datasets = await fetchClassDatasets(currentClass.id, expNo);
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

async function renderManageTab() {
  const el = document.getElementById("tab-manage");
  el.innerHTML = "";

  const activeBox = document.createElement("div");
  activeBox.className = "th-toolbar";
  activeBox.innerHTML = `<label>지금 진행 중인 실험</label>`;
  [1, 2, 3].forEach((n) => {
    const btn = document.createElement("button");
    btn.className = "btn small" + (currentClass.activeExp === n ? "" : " ghost");
    btn.textContent = `실험 ${n}로 전환`;
    btn.addEventListener("click", async () => {
      await setActiveExpField(currentClass.id, n);
      await renderManageTab();
    });
    activeBox.append(btn);
  });
  el.append(activeBox);
  if (MODE === "mock") el.append(notice("🧪 연습 모드에서는 전환·삭제가 화면에만 반영되고 저장되지 않아요."));

  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead><tr><th>실험</th><th>모둠</th><th>제목</th><th>측정 시각</th><th>점 개수</th><th></th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  el.append(table);

  const all = (await Promise.all([1, 2, 3].map((n) => fetchClassDatasets(currentClass.id, n)))).flat();
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
      await deleteDatasetDoc(currentClass.id, d.id);
      tr.remove();
    });
    tbody.append(tr);
  });
}

// ── 4. 교실 화면용 실시간 뷰 ─────────────────────────────

let tvTimer = null;

async function renderTvTab() {
  const el = document.getElementById("tab-tv");
  el.innerHTML = "";

  const enterBtn = document.createElement("button");
  enterBtn.className = "btn big";
  enterBtn.textContent = "교실 화면 모드로 보기 (전체화면)";
  enterBtn.addEventListener("click", () => openTvView());
  el.append(enterBtn);
}

async function openTvView() {
  const view = document.createElement("div");
  view.className = "tv-view";
  view.innerHTML = `
    <button class="btn ghost tv-exit">닫기</button>
    <h1>${currentClass.name || "우리 반"} · 지금 실험 ${currentClass.activeExp ?? "—"}</h1>
    <div class="tv-grid"></div>
  `;
  document.body.append(view);
  view.querySelector(".tv-exit").addEventListener("click", closeTv);
  if (view.requestFullscreen) view.requestFullscreen().catch(() => {});

  async function refresh() {
    const expNo = currentClass.activeExp || 1;
    const datasets = await fetchClassDatasets(currentClass.id, expNo);
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

// ── 도우미 ───────────────────────────────────────────────

function notice(text) {
  const box = document.createElement("div");
  box.className = "th-notice";
  box.textContent = text;
  return box;
}
