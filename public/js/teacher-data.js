// js/teacher-data.js — 교사 대시보드용 데이터 조회 (세션 E)
//
// 주의: js/data.js의 함수들(listClassDatasets 등)은 "이 브라우저에 저장된 학생 세션의 classId"에
// 고정돼 있어 교사가 다른 classId를 볼 때는 못 쓴다. 아래 함수들은 연습 모드에서 data.js를 재사용하고,
// 실제 Firebase 모드에서는 classId를 직접 받는 임시 구현이다 (세션 A에 정식 함수 추가 요청함 —
// 정리되면 이 파일 안쪽을 data.js 호출로 바꾸고, 필요 없어지면 이 파일 자체를 지워도 된다).

import { getFirebase } from "./firebase-init.js";
import { MODE, listClassDatasets, getAnalysis } from "./data.js";

export const DEFAULT_VISIBLE_EXPS = [1, 2, 3]; // visibleExps 필드가 없는 학급의 기본값 (SPEC §5.2, v2.0)

// 새 입장 코드는 한 형태로만 저장한다. 학생·수집기의 기존 코드 호환 조회는
// 그대로 두므로, 예전에 소문자·혼합 대소문자로 만든 학급도 계속 들어갈 수 있다.
export function normalizeJoinCode(value) {
  return String(value || "").trim().toUpperCase();
}

function validateJoinCode(joinCode) {
  if (!joinCode) throw new Error("입장 코드를 입력해 주세요.");
  if (joinCode.includes("/")) throw new Error("입장 코드에는 /를 쓸 수 없어요.");
}

async function assertJoinCodeAvailable(f, db, joinCode, oldJoinCode = "", targetClassId = "") {
  // 새 코드는 대문자로 저장하지만, 예전에 전부 소문자로 저장된 코드와도
  // 충돌하지 않게 두 형태를 확인한다. 현재 학급의 옛 코드는 검사에서 뺀다.
  // 부분 실패 뒤 재시도할 때 이미 같은 학급을 가리키는 새 코드는 성공으로 본다.
  const candidates = [...new Set([joinCode, joinCode.toLowerCase()])]
    .filter((code) => code !== oldJoinCode);
  for (const code of candidates) {
    const snap = await f.getDoc(f.doc(db, "joinCodes", code));
    if (snap.exists()) {
      if (targetClassId && snap.data()?.classId === targetClassId) continue;
      throw new Error("이미 쓰이고 있는 입장 코드예요. 다른 코드를 써 주세요.");
    }
  }
}

async function assertNoOwnedLegacyCollision(f, db, teacherUid, joinCode, currentClassId = "") {
  // joinCodes는 보안상 list가 막혀 있어 전체 혼합 대소문자 문서를 검색할 수 없다.
  // 대신 이 교사가 소유한 기존 classes의 joinCode를 비교해 TeSt/TEST 충돌을 잡는다.
  const q = f.query(f.collection(db, "classes"), f.where("teacherUid", "==", teacherUid));
  const snap = await f.getDocs(q);
  const collision = snap.docs.find((docSnap) => (
    docSnap.id !== currentClassId
    && normalizeJoinCode(docSnap.data()?.joinCode) === joinCode
  ));
  if (collision) {
    throw new Error("대소문자만 다른 입장 코드를 쓰는 기존 학급이 있어요. 다른 코드를 써 주세요.");
  }
}

async function deleteJoinCodeIfOwned(f, db, joinCode, classId) {
  if (!joinCode) return;
  const ref = f.doc(db, "joinCodes", joinCode);
  const snap = await f.getDoc(ref);
  if (!snap.exists()) return;
  if (snap.data()?.classId !== classId) {
    throw new Error(`입장 코드 "${joinCode}"가 다른 학급을 가리켜 자동으로 지우지 않았어요.`);
  }
  await f.deleteDoc(ref);
}

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

// classes/{classId}/analyses 컬렉션을 한 번에 읽어 문서 id("exp{번호}_{모둠}")를 키로 돌려준다.
// 모둠 여러 개 × 실험 여러 개를 fetchAnalysis로 하나씩 읽는 대신 이걸로 한 번에 대체한다.
// firestore.rules가 이 컬렉션의 목록 읽기를 허용한다(allow read: if signedIn()).
// 연습 모드는 이런 컬렉션 조회가 없어 null을 돌려주고, 호출부는 그때 fetchAnalysis로 되돌아간다.
export async function fetchAllAnalyses(classId) {
  if (MODE === "mock") return null;
  const { db, f } = await fsCtx();
  const snap = await f.getDocs(f.collection(db, "classes", classId, "analyses"));
  const byId = {};
  snap.docs.forEach((d) => { byId[d.id] = d.data(); });
  return byId;
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
  joinCode = normalizeJoinCode(joinCode);
  validateJoinCode(joinCode);
  if (MODE === "mock") {
    return { id: "mock-class-" + Date.now(), name, joinCode, teacherUid, activeExp: 1, visibleExps: DEFAULT_VISIBLE_EXPS };
  }
  const { db, f } = await fsCtx();

  // 입장 코드 중복 확인 — 이미 쓰이는 코드를 덮어쓰면 다른 반 학생이 엉뚱한 학급으로 들어간다
  await assertNoOwnedLegacyCollision(f, db, teacherUid, joinCode);
  await assertJoinCodeAvailable(f, db, joinCode);

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
  joinCode = normalizeJoinCode(joinCode);
  validateJoinCode(joinCode);
  if (MODE === "mock") return;
  const { db, f } = await fsCtx();
  const classRef = f.doc(db, "classes", classId);
  const classSnap = await f.getDoc(classRef);
  if (!classSnap.exists()) throw new Error("수정할 학급을 찾지 못했어요. 목록을 새로 불러와 주세요.");
  const current = classSnap.data();
  const currentJoinCode = current.joinCode || oldJoinCode || "";

  await assertNoOwnedLegacyCollision(f, db, current.teacherUid, joinCode, classId);
  await assertJoinCodeAvailable(f, db, joinCode, currentJoinCode, classId);

  // 서버의 현재 상태를 기준으로 항상 같은 결과를 만들게 해 부분 실패 뒤 재시도도 안전하게 한다.
  await f.updateDoc(classRef, { name, joinCode });

  // 새 코드가 이미 같은 학급을 가리켜도 setDoc은 같은 값을 다시 써서 성공한다.
  try {
    await f.setDoc(f.doc(db, "joinCodes", joinCode), { classId });
  } catch (err) {
    throw new Error(
      `학급 정보는 저장됐지만 새 입장 코드("${joinCode}") 등록에 실패했어요. ` +
      "인터넷 연결을 확인한 뒤 같은 내용으로 다시 저장해 주세요."
    );
  }

  // 화면이 오래된 값을 들고 있거나 앞 시도에서 일부만 성공했을 수 있으므로,
  // 서버의 이전 코드와 화면이 기억한 옛 코드를 모두 후보로 삼아 같은 학급 것만 지운다.
  const staleCodes = [...new Set([currentJoinCode, oldJoinCode])]
    .filter((code) => code && code !== joinCode);
  try {
    for (const staleCode of staleCodes) {
      await deleteJoinCodeIfOwned(f, db, staleCode, classId);
    }
  } catch (err) {
    throw new Error(
      `새 입장 코드("${joinCode}")는 등록됐지만 옛 코드를 정리하지 못했어요. ` +
      "같은 내용으로 다시 저장하면 정리를 이어서 시도합니다."
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
  const classRef = f.doc(db, "classes", classId);
  const classSnap = await f.getDoc(classRef);
  if (!classSnap.exists()) return;
  const actualJoinCode = classSnap.data()?.joinCode || joinCode || "";

  // 하위 데이터를 지우기 전에 입장 코드가 정말 이 학급 것인지 확인한다.
  // 다른 학급 코드를 잘못 지우거나, 실패를 숨긴 채 고아 코드를 남기지 않는다.
  let joinCodeRef = null;
  if (actualJoinCode) {
    joinCodeRef = f.doc(db, "joinCodes", actualJoinCode);
    const joinCodeSnap = await f.getDoc(joinCodeRef);
    if (joinCodeSnap.exists() && joinCodeSnap.data()?.classId !== classId) {
      throw new Error("입장 코드가 다른 학급을 가리켜 삭제를 멈췄어요. 관리자에게 알려 주세요.");
    }
  }

  const [dSnap, aSnap] = await Promise.all([
    f.getDocs(f.collection(db, "classes", classId, "datasets")),
    f.getDocs(f.collection(db, "classes", classId, "analyses")),
  ]);
  await Promise.all([
    ...dSnap.docs.map((d) => f.deleteDoc(d.ref)),
    ...aSnap.docs.map((d) => f.deleteDoc(d.ref)),
  ]);

  // 입장 코드와 학급 문서는 마지막에 한 배치로 지워 둘 중 하나만 남지 않게 한다.
  const batch = f.writeBatch(db);
  if (joinCodeRef) batch.delete(joinCodeRef);
  batch.delete(classRef);
  await batch.commit();
}
