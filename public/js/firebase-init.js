// js/firebase-init.js — Firebase 초기화 (세션 A)
//
// ★ 설정값은 이 파일에 쓰지 않는다 ★
// 실제 설정값은 js/firebase-config.js에 두고, 그 파일은 .gitignore에 올라 있어
// GitHub에 커밋되지 않는다 (CLAUDE.md 절대 규칙 7).
//
// 처음 설정하는 방법:
//   1. js/firebase-config.example.js를 복사해 js/firebase-config.js로 저장
//   2. Firebase 콘솔 → 프로젝트 설정 → 내 앱에서 값을 복사해 채우기
//
// firebase-config.js는 index.html·join.html이 <script> 태그로 먼저 불러온다.
// (teacher.html을 만드는 세션 E도 같은 태그를 넣어야 한다)
// 파일이 없으면 404가 나며 설정이 비고, 앱은 "연습 모드"로 돌아간다 —
// 서버 없이 가짜 데이터로 모든 화면을 써 볼 수 있는 상태다.

const firebaseConfig =
  (typeof window !== "undefined" && window.__FIREBASE_CONFIG__) || {};

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
    // 학교망처럼 WebChannel 스트리밍이 막힌 환경에서 저장·조회가 수십 초씩
    // 걸리는 문제 때문에, 롱폴링 자동 감지를 켠다. 정상 네트워크에서는
    // 기존처럼 빠른 스트리밍을 쓰고, 막힌 환경에서만 롱폴링으로 붙는다.
    // (항상 강제하는 experimentalForceLongPolling이 아니라 자동 감지를 쓴다)
    db: fsMod.initializeFirestore(app, { experimentalAutoDetectLongPolling: true }),
    authMod, // 인증 함수 모음 (signInAnonymously 등)
    fsMod,   // Firestore 함수 모음 (collection, query 등)
  };
  return cached;
}
