// js/auth.js — 학급 코드 입장 + 익명 인증 (세션 A)
//
// 학생은 계정을 만들지 않는다. 최초 1회 학급 코드와 모둠 번호를 입력하면
// localStorage에 저장되어 다음부터 자동 입장한다. (SPEC §5.3)
// localStorage에는 학급 코드·모둠 번호·화면 설정만 둔다. 측정 데이터는 Firestore에.

import { isConfigured, getFirebase } from "./firebase-init.js";

const KEYS = {
  classId: "sds:classId",
  className: "sds:className",
  joinCode: "sds:joinCode",
  groupNo: "sds:groupNo",
};

// 저장된 입장 정보. 없으면 null (→ 입장 화면을 보여줘야 함)
export function getSession() {
  const classId = localStorage.getItem(KEYS.classId);
  const groupNo = Number(localStorage.getItem(KEYS.groupNo));
  if (!classId || !groupNo) return null;
  return {
    classId,
    className: localStorage.getItem(KEYS.className) || "",
    joinCode: localStorage.getItem(KEYS.joinCode) || "",
    groupNo,
    groupId: "g" + groupNo,        // 모둠 문서 아이디 규칙: g1 ~ g6
    groupName: groupNo + "모둠",
  };
}

// 학급 코드로 입장한다. 성공하면 세션을 반환하고, 실패하면 한국어 메시지로 throw.
export async function join(joinCode, groupNo) {
  joinCode = (joinCode || "").trim();
  groupNo = Number(groupNo);
  if (!joinCode) throw new Error("학급 코드를 입력해 주세요.");
  if (!(groupNo >= 1 && groupNo <= 8)) throw new Error("모둠을 골라 주세요.");

  if (!isConfigured) {
    // 연습 모드: 서버가 없으므로 어떤 코드든 받아 준다
    store("mock-class", "연습용 학급", joinCode, groupNo);
    return getSession();
  }

  const { auth, db, authMod, fsMod } = await getFirebase();
  await authMod.signInAnonymously(auth);

  const q = fsMod.query(
    fsMod.collection(db, "classes"),
    fsMod.where("joinCode", "==", joinCode),
    fsMod.limit(1),
  );
  const snap = await fsMod.getDocs(q);
  if (snap.empty) throw new Error("학급 코드를 찾을 수 없어요. 선생님께 다시 확인해 주세요.");

  const doc = snap.docs[0];
  store(doc.id, doc.data().name || "", joinCode, groupNo);
  return getSession();
}

// 로그인(익명)을 보장하고 uid를 돌려준다. 데이터 저장 전에 호출한다.
export async function ensureAuth() {
  if (!isConfigured) return "mock-user";
  const { auth, authMod } = await getFirebase();
  if (auth.currentUser) return auth.currentUser.uid;
  const cred = await authMod.signInAnonymously(auth);
  return cred.user.uid;
}

// 입장 정보를 지운다 (학급을 잘못 골랐을 때 등)
export function leave() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
}

function store(classId, className, joinCode, groupNo) {
  localStorage.setItem(KEYS.classId, classId);
  localStorage.setItem(KEYS.className, className);
  localStorage.setItem(KEYS.joinCode, joinCode);
  localStorage.setItem(KEYS.groupNo, String(groupNo));
}
