// js/firebase-config.example.js — Firebase 설정값 본보기 (세션 A)
//
// 사용법:
//   1. 이 파일을 같은 폴더에 firebase-config.js라는 이름으로 복사한다
//   2. Firebase 콘솔 → 프로젝트 설정 → 내 앱 → SDK 설정에서 값을 복사해 채운다
//
// 채운 firebase-config.js는 .gitignore에 올라 있어 GitHub에 올라가지 않는다.
// 값이 비어 있으면(또는 파일이 없으면) 앱은 자동으로 "연습 모드"가 된다.
window.__FIREBASE_CONFIG__ = {
  apiKey: "",             // ← 여기에 붙여 넣기
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};
