// js/teacher-data.js — 교사 대시보드용 데이터 조회 (세션 E)
//
// 주의: js/data.js의 함수들(listClassDatasets 등)은 "이 브라우저에 저장된 학생 세션의 classId"에
// 고정돼 있어 교사가 다른 classId를 볼 때는 못 쓴다. 아래 함수들은 연습 모드에서 data.js를 재사용하고,
// 실제 Firebase 모드에서는 classId를 직접 받는 임시 구현이다 (세션 A에 정식 함수 추가 요청함 —
// 정리되면 이 파일 안쪽을 data.js 호출로 바꾸고, 필요 없어지면 이 파일 자체를 지워도 된다).

import { getFirebase } from "./firebase-init.js";
import { MODE, listClassDatasets, getAnalysis } from "./data.js";

export const DEFAULT_VISIBLE_EXPS = [1, 2, 3]; // visibleExps 필드가 없는 학급의 기본값 (SPEC §5.2, v2.0)

async function fsCtx() {
  const { db, fsMod } = await getFirebase();
  return { db, f: fsMod };
}

export async function fetchMyClasses(uid) {
  if (MODE === "mock") return [{ id: "mock-class", name: "연습용 학급", activeExp: 1 }];
  const { db, f } = await fsCtx();
  const q = f.query(f.collection(db, "classes"), f.where("teacherUid", "==", uid));
  const snap = await f.getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function fetchClassDatasets(classId, expNo) {
  if (MODE === "mock") return listClassDatasets(expNo);
  const { db, f } = await fsCtx();
  const q = f.query(f.collection(db, "classes", classId, "datasets"), f.where("expNo", "==", expNo));
  const snap = await f.getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function fetchAnalysis(classId, expNo, groupId) {
  if (MODE === "mock") return getAnalysis(expNo, groupId);
  const { db, f } = await fsCtx();
  const snap = await f.getDoc(f.doc(db, "classes", classId, "analyses", `exp${expNo}_${groupId}`));
  return snap.exists() ? snap.data() : { answers: {}, conclusion: "" };
}

export async function deleteDatasetDoc(classId, datasetId) {
  if (MODE === "mock") return; // 연습 모드는 실제로 지우지 않는다
  const { db, f } = await fsCtx();
  await f.deleteDoc(f.doc(db, "classes", classId, "datasets", datasetId));
}

export async function setActiveExpField(classId, expNo) {
  if (MODE === "mock") return;
  const { db, f } = await fsCtx();
  await f.updateDoc(f.doc(db, "classes", classId), { activeExp: expNo });
}

// classes.visibleExps — 필드가 없으면 [1,2,3]으로 간주한다 (SPEC §5.2, v2.0)
export function getVisibleExps(cls) {
  return Array.isArray(cls?.visibleExps) ? cls.visibleExps : DEFAULT_VISIBLE_EXPS;
}

export async function setVisibleExpsField(classId, exps) {
  if (MODE === "mock") return;
  const { db, f } = await fsCtx();
  await f.updateDoc(f.doc(db, "classes", classId), { visibleExps: exps });
}
