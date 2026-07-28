// js/data.js — Firestore 읽기·쓰기 공통 함수 (세션 A)
//
// 세션 B·C·D는 이 파일의 함수만 호출한다. Firestore를 직접 부르지 않는다. (SPEC §7)
//
// Firebase 설정이 비어 있으면 "연습 모드"로 동작한다:
// 가짜 데이터를 메모리에 채워 두고 같은 함수 시그니처로 응답한다.
// (새로고침하면 연습 모드 데이터는 사라진다 — 화면에 안내함)

import { isConfigured, getFirebase } from "./firebase-init.js";
import { getSession, ensureAuth } from "./auth.js";

// "firebase" 또는 "mock" — 화면에서 연습 모드 안내를 띄울 때 쓴다
export const MODE = isConfigured ? "firebase" : "mock";

// 측정 1회의 점 개수 상한 (문서 1MB 제한, SPEC §5.2)
export const MAX_POINTS = 5000;

export function validateDatasetPoints(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error("측정값이 하나도 없어요. 값을 한 번 이상 잰 뒤 저장해 주세요.");
  }
  if (points.length > MAX_POINTS) {
    throw new Error(`측정값이 ${MAX_POINTS}개를 넘었어요. 측정을 나누거나 간격을 늘려 주세요.`);
  }
  let previousT = -Infinity;
  for (const point of points) {
    if (!point || typeof point !== "object"
        || !Number.isFinite(point.t) || !Number.isFinite(point.v)) {
      throw new Error("측정값의 시간과 값은 숫자여야 해요.");
    }
    if (point.t < 0 || point.t < previousT) {
      throw new Error("측정 시간이 올바른 순서가 아니에요.");
    }
    previousT = point.t;
  }
}

// ── 연습 모드 저장소 ─────────────────────────────────────
const memory = { datasets: [], analyses: new Map() };

// 여러 화면이 동시에 호출해도 씨앗 데이터는 한 번만, 끝까지 채워진 뒤에 읽히도록
// 프라미스를 공유한다.
let seedPromise = null;
function seedMemory() {
  if (!seedPromise) seedPromise = fillSeeds();
  return seedPromise;
}

async function fillSeeds() {
  const { generateMock } = await import("../mock/mock-data.js");
  const my = getSession()?.groupId || "g1";
  const other = my === "g2" ? "g3" : "g2"; // 학급 비교 화면 확인용 다른 모둠
  const seeds = [
    [1, "창문 닫음", my], [1, "창문 열음", my], [1, "쉬는 시간", other],
    [2, "어두움", my], [2, "보통", my], [2, "밝음", my], [2, "밝음", other],
    [3, "안정 시", my], [3, "심한 운동 후", my], [3, "가벼운 운동 후", other],
  ];
  seeds.forEach(([expNo, cond, groupId], i) => {
    memory.datasets.push({ ...generateMock(expNo, cond), id: "mock-" + (i + 1), groupId });
  });
}

// ── Firestore 도우미 ────────────────────────────────────
async function fs() {
  const { db, fsMod } = await getFirebase();
  const classId = getSession()?.classId;
  if (!classId) throw new Error("학급에 입장한 뒤에 사용할 수 있어요.");
  return { db, f: fsMod, classId };
}

// Firestore Timestamp → Date 로 통일해서 돌려준다
function fromDoc(doc) {
  const d = { id: doc.id, ...doc.data() };
  for (const k of ["startedAt", "createdAt", "updatedAt"]) {
    if (d[k]?.toDate) d[k] = d[k].toDate();
  }
  return d;
}

function byNewest(a, b) {
  return (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0);
}

// ── 측정(datasets) ──────────────────────────────────────

// 한 모둠의 측정 목록 (최신순)
export async function listDatasets(expNo, groupId) {
  if (MODE === "mock") {
    await seedMemory();
    return memory.datasets.filter((d) => d.expNo === expNo && d.groupId === groupId).sort(byNewest);
  }
  const { db, f, classId } = await fs();
  const q = f.query(
    f.collection(db, "classes", classId, "datasets"),
    f.where("expNo", "==", expNo),
    f.where("groupId", "==", groupId),
  );
  return (await f.getDocs(q)).docs.map(fromDoc).sort(byNewest);
}

// 학급 전체의 측정 목록 (모둠 비교용, 최신순)
export async function listClassDatasets(expNo) {
  if (MODE === "mock") {
    await seedMemory();
    return memory.datasets.filter((d) => d.expNo === expNo).sort(byNewest);
  }
  const { db, f, classId } = await fs();
  const q = f.query(
    f.collection(db, "classes", classId, "datasets"),
    f.where("expNo", "==", expNo),
  );
  return (await f.getDocs(q)).docs.map(fromDoc).sort(byNewest);
}

// 측정 1회 저장 → 새 문서 아이디를 돌려준다
export async function saveDataset(dataset) {
  validateDatasetPoints(dataset.points);
  const session = getSession();
  const uid = await ensureAuth();
  const doc = {
    ...dataset,
    groupId: dataset.groupId || session?.groupId || "",
    ownerUid: uid,
    createdAt: dataset.createdAt || new Date(),
  };
  if (MODE === "mock") {
    await seedMemory();
    doc.id = "mock-" + (memory.datasets.length + 1);
    memory.datasets.push(doc);
    return doc.id;
  }
  const { db, f, classId } = await fs();
  const ref = await f.addDoc(f.collection(db, "classes", classId, "datasets"), doc);
  return ref.id;
}

// ── 분석(analyses) ──────────────────────────────────────
// 분석은 "실험 1개 × 모둠 1개 = 문서 1개" 규칙으로 저장한다.
function analysisId(expNo, groupId) {
  return `exp${expNo}_${groupId}`;
}

// 항상 빈칸이 채워진 분석 객체를 돌려준다 (없으면 새로 만든 형태)
function emptyAnalysis(expNo, groupId) {
  return {
    expNo, groupId,
    datasetIds: [], chartType: "line", chartOptions: {},
    answers: {}, conclusion: "", aiLog: [],
  };
}

export async function getAnalysis(expNo, groupId) {
  if (MODE === "mock") {
    return memory.analyses.get(analysisId(expNo, groupId)) || emptyAnalysis(expNo, groupId);
  }
  const { db, f, classId } = await fs();
  const snap = await f.getDoc(f.doc(db, "classes", classId, "analyses", analysisId(expNo, groupId)));
  if (!snap.exists()) return emptyAnalysis(expNo, groupId);
  return { ...emptyAnalysis(expNo, groupId), ...fromDoc(snap) };
}

export async function saveAnalysis(analysis) {
  const { expNo, groupId } = analysis;
  if (!expNo || !groupId) throw new Error("분석에는 expNo와 groupId가 있어야 해요.");
  const doc = { ...analysis, updatedAt: new Date(), createdAt: analysis.createdAt || new Date() };
  if (MODE === "mock") {
    memory.analyses.set(analysisId(expNo, groupId), doc);
    return;
  }
  const { db, f, classId } = await fs();
  delete doc.id; // 문서 안에 id 필드를 남기지 않는다
  await f.setDoc(f.doc(db, "classes", classId, "analyses", analysisId(expNo, groupId)), doc, { merge: true });
}

// ── 학급 정보 ───────────────────────────────────────────
// 홈 화면의 "진행 중" 배지 등에 쓴다 (세션 A 내부용 추가 함수)
// exists: false면 localStorage의 classId가 더 이상 없는 학급을 가리킨다는 뜻이다
// (교사가 학급을 지웠거나, 낡은 기기에 옛 코드가 남아 있는 경우 — BUG-08).
// 쓰기(saveDataset·saveAnalysis)는 규칙의 classExists()가 막아 permission-denied로
// 조용히 실패하므로, index.html이 이 값을 보고 진입 전에 재입장을 안내한다.
export async function getClassInfo() {
  if (MODE === "mock") {
    return { name: "연습용 학급", activeExp: 1, exists: true };
  }
  const { db, f, classId } = await fs();
  const snap = await f.getDoc(f.doc(db, "classes", classId));
  return snap.exists() ? { ...fromDoc(snap), exists: true } : { name: "", activeExp: 1, exists: false };
}
