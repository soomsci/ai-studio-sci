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
  if (MODE === "mock") {
    return [{ id: "mock-class", name: "연습용 학급", joinCode: "MOCK-1", activeExp: 1, visibleExps: DEFAULT_VISIBLE_EXPS }];
  }
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

// 학급 만들기 (v2.1) — classes 문서와 joinCodes 문서를 짝으로 만든다.
// 순서가 중요하다: joinCodes 쓰기 규칙이 classes 문서의 teacherUid를 확인하므로
// classes를 먼저 만들고, 그다음 joinCodes를 순차로 만든다 (배치로 묶으면 안 됨, SPEC §5.2).
export async function createClass({ name, joinCode, teacherUid }) {
  if (MODE === "mock") {
    return { id: "mock-class-" + Date.now(), name, joinCode, teacherUid, activeExp: 1, visibleExps: DEFAULT_VISIBLE_EXPS };
  }
  const { db, f } = await fsCtx();

  // 입장 코드 중복 확인 — 이미 쓰이는 코드를 덮어쓰면 다른 반 학생이 엉뚱한 학급으로 들어간다
  const codeSnap = await f.getDoc(f.doc(db, "joinCodes", joinCode));
  if (codeSnap.exists()) {
    throw new Error("이미 쓰이고 있는 입장 코드예요. 다른 코드를 써 주세요.");
  }

  // 1) classes 문서 먼저
  const classRef = await f.addDoc(f.collection(db, "classes"), {
    name, joinCode, teacherUid, activeExp: 1, visibleExps: DEFAULT_VISIBLE_EXPS, createdAt: new Date(),
  });

  // 2) joinCodes 문서 — 실패하면 학생이 입장 못 하는 반쪽 학급이 남으므로, 방금 만든 classes 문서를 되돌린다
  try {
    await f.setDoc(f.doc(db, "joinCodes", joinCode), { classId: classRef.id });
  } catch (err) {
    let rolledBack = false;
    try {
      await f.deleteDoc(f.doc(db, "classes", classRef.id));
      rolledBack = true;
    } catch { /* 되돌리기도 실패 — 아래에서 학급 ID를 알려준다 */ }

    throw new Error(
      rolledBack
        ? "입장 코드 등록에 실패해서 학급 만들기를 취소했어요. 인터넷 연결을 확인하고 다시 시도해 주세요."
        : `학급 문서는 만들어졌지만 입장 코드 등록에 실패했고, 되돌리기도 실패했어요. ` +
          `이 상태로는 학생이 입장할 수 없어요. 개발자에게 학급 ID "${classRef.id}"를 알려서 정리를 요청해 주세요.`
    );
  }

  return { id: classRef.id, name, joinCode, teacherUid, activeExp: 1, visibleExps: DEFAULT_VISIBLE_EXPS };
}

// 학급 정보 수정 (v2.3) — 반 이름은 바로 고치면 되지만, 입장 코드가 바뀌면 세 단계를 순서대로 밟는다:
// ① 새 코드 중복 확인 → ② classes.joinCode 갱신 → ③ 새 joinCodes 생성 + 옛 joinCodes 삭제.
// 셋 중 하나라도 실패하면 학생이 입장 못 하는 상태가 남을 수 있어 단계별로 다른 안내를 던진다.
export async function updateClass(classId, { name, joinCode, oldJoinCode }) {
  if (MODE === "mock") return;
  const { db, f } = await fsCtx();
  const codeChanged = joinCode && joinCode !== oldJoinCode;

  if (codeChanged) {
    const codeSnap = await f.getDoc(f.doc(db, "joinCodes", joinCode));
    if (codeSnap.exists()) {
      throw new Error("이미 쓰이고 있는 입장 코드예요. 다른 코드를 써 주세요.");
    }
  }

  // ② classes 문서 갱신 (이름 + 코드가 바뀌었으면 코드도 함께)
  await f.updateDoc(f.doc(db, "classes", classId), {
    name, ...(codeChanged ? { joinCode } : {}),
  });

  if (!codeChanged) return;

  // ③-1 새 joinCodes 문서를 만든다
  try {
    await f.setDoc(f.doc(db, "joinCodes", joinCode), { classId });
  } catch (err) {
    throw new Error(
      `반 이름은 저장됐지만 새 입장 코드("${joinCode}") 등록에 실패했어요. ` +
      `아직 새 코드로는 입장이 안 돼요. 옛 코드("${oldJoinCode}")는 그대로 쓸 수 있어요. 다시 시도해 주세요.`
    );
  }

  // ③-2 옛 joinCodes 문서를 지운다
  try {
    await f.deleteDoc(f.doc(db, "joinCodes", oldJoinCode));
  } catch (err) {
    throw new Error(
      `새 입장 코드("${joinCode}")는 등록됐지만 옛 코드("${oldJoinCode}")를 지우는 데는 실패했어요. ` +
      `당분간 두 코드 모두 입장이 될 수 있어요. 다시 시도해서 옛 코드를 지워 주세요.`
    );
  }
}

// 학급 안의 측정·분석 개수를 센다 — 삭제 전 경고 문구에 쓴다 (v2.3)
export async function countClassContents(classId) {
  if (MODE === "mock") return { datasets: 0, analyses: 0 };
  const { db, f } = await fsCtx();
  const [dSnap, aSnap] = await Promise.all([
    f.getDocs(f.collection(db, "classes", classId, "datasets")),
    f.getDocs(f.collection(db, "classes", classId, "analyses")),
  ]);
  return { datasets: dSnap.size, analyses: aSnap.size };
}

// 학급 삭제 (v2.3) — 되돌릴 수 없다. Firestore는 하위 컬렉션을 자동으로 지우지 않으므로
// datasets·analyses를 먼저 지우고(안 지우면 고아 문서로 남는다, §5.2), 그다음 joinCodes·classes를 지운다.
// groups 하위 컬렉션은 지금 아무 코드도 안 써서 삭제 대상에서 뺀다(§5.2).
export async function deleteClass(classId, { joinCode }) {
  if (MODE === "mock") return;
  const { db, f } = await fsCtx();

  const [dSnap, aSnap] = await Promise.all([
    f.getDocs(f.collection(db, "classes", classId, "datasets")),
    f.getDocs(f.collection(db, "classes", classId, "analyses")),
  ]);
  await Promise.all([
    ...dSnap.docs.map((d) => f.deleteDoc(d.ref)),
    ...aSnap.docs.map((d) => f.deleteDoc(d.ref)),
  ]);

  if (joinCode) {
    await f.deleteDoc(f.doc(db, "joinCodes", joinCode)).catch(() => {});
  }
  await f.deleteDoc(f.doc(db, "classes", classId));
}
