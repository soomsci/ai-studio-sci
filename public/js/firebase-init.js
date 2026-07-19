// js/firebase-init.js — Firebase 초기화 (세션 A)
//
// ★ 설정값 채우는 방법 ★
// Firebase 콘솔 → 프로젝트 설정 → 내 앱 → SDK 설정에서 값을 복사해
// 아래 빈 따옴표 안에 붙여 넣으면 됩니다. 코드 다른 곳은 건드릴 필요 없습니다.
//
// 설정값이 비어 있으면 앱 전체가 자동으로 "연습 모드"로 돌아갑니다.
// 연습 모드에서는 서버 없이 가짜 데이터(mock)로 모든 화면을 써 볼 수 있습니다.

const firebaseConfig = {
  apiKey: "",             // ← 여기에 붙여 넣기
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// 설정이 채워졌는지 여부. false면 연습 모드.
export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let cached = null;

// Firebase SDK를 필요할 때만 CDN에서 불러온다.
// 연습 모드에서는 네트워크 요청 자체를 하지 않는다.
export async function getFirebase() {
  if (!isConfigured) return null;
  if (cached) return cached;

  const [appMod, authMod, fsMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
  ]);

  const app = appMod.initializeApp(firebaseConfig);
  cached = {
    app,
    auth: authMod.getAuth(app),
    db: fsMod.getFirestore(app),
    authMod, // 인증 함수 모음 (signInAnonymously 등)
    fsMod,   // Firestore 함수 모음 (collection, query 등)
  };
  return cached;
}
