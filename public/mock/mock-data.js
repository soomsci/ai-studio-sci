// public/mock/mock-data.js — 실험별 가짜 데이터 생성기 (세션 A)
// (Firebase Hosting이 public/만 배포하므로 public/ 안에 둔다)
//
// 사용법 (public/js/ 안의 파일 기준):
//   import { generateMock } from "../mock/mock-data.js";
//   const dataset = generateMock(1, "창문 닫음");
//
// 반환값은 docs/SPEC.md §5의 datasets 문서와 같은 형태다.
// 나중에 수집기(collector/)가 같은 형태로 올리므로 교체 비용이 없다.
// groupId·ownerUid는 빈 문자열로 둔다 — saveDataset()이 입장한 모둠 값으로 채워 준다.
//
// 조건별 시나리오:
//   실험1 (교실 CO₂)  : 창문을 닫으면 서서히 차오르고, 열면 빠르게 내려간다
//   실험2 (식물 CO₂)  : 밝을수록 광합성으로 CO₂가 빨리 줄고, 어두우면 호흡 때문에 늘어난다
//   실험3 (심박수)    : 운동 직후 높았다가 안정 시 수준으로 서서히 회복한다
//   (실험3의 폐활량·날숨 CO₂는 센서 지원이 불확실해 수동 입력 예정 — SPEC §11 세션 F 참고)

// 측정값에 섞이는 무작위 흔들림
function noise(amp) {
  return (Math.random() - 0.5) * 2 * amp;
}

// 시작값에서 목표값으로 서서히 다가가는 곡선. tau(초)가 클수록 천천히 변한다.
// 실제 CO₂ 축적·환기, 심박수 회복이 모두 이런 모양을 따른다.
function approach(start, target, t, tau) {
  return target + (start - target) * Math.exp(-t / tau);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ── 실험 1: 교실 CO₂ (ppm) ──────────────────────────────
function mockExp1(condition) {
  const intervalSec = 10;
  const points = [];
  const events = [];
  let durationSec = 45 * 60;

  if (condition === "창문 열음") {
    // 환기: 높은 농도에서 바깥 공기 수준으로 빠르게 하강 (약 3~4분 만에 기준선 아래)
    durationSec = 20 * 60;
    const start = 1500 + noise(150);
    events.push({ t: 0, label: "창문 열기" });
    for (let t = 0; t <= durationSec; t += intervalSec) {
      points.push({ t, v: Math.round(approach(start, 450, t, 300) + noise(12)) });
    }
  } else if (condition === "쉬는 시간") {
    // 수업(닫힘) → 쉬는 시간에 창문 개방 → 다시 닫힘
    const start = 650 + noise(50);
    const openAt = 25 * 60;
    const closeAt = 35 * 60;
    events.push({ t: openAt, label: "창문 열기" }, { t: closeAt, label: "창문 닫기" });
    let vOpen = 0, vClose = 0;
    for (let t = 0; t <= durationSec; t += intervalSec) {
      let v;
      if (t < openAt) {
        v = approach(start, 2600, t, 5400);
        vOpen = v;
      } else if (t < closeAt) {
        v = approach(vOpen, 460, t - openAt, 300);
        vClose = v;
      } else {
        v = approach(vClose, 2600, t - closeAt, 5400);
      }
      points.push({ t, v: Math.round(v + noise(15)) });
    }
  } else if (condition === "문만 열음") {
    // 복도 쪽 문만 개방: 내려가긴 하지만 창문보다 훨씬 느리고 덜 내려간다
    durationSec = 30 * 60;
    const start = 1250 + noise(100);
    events.push({ t: 0, label: "문 열기" });
    for (let t = 0; t <= durationSec; t += intervalSec) {
      points.push({ t, v: Math.round(approach(start, 850, t, 900) + noise(12)) });
    }
  } else {
    // 기본: "창문 닫음" — 약 20 ppm/분씩 상승, 19분쯤 1,000ppm 돌파
    const start = 620 + noise(60);
    for (let t = 0; t <= durationSec; t += intervalSec) {
      points.push({ t, v: Math.round(approach(start, 2600, t, 5400) + noise(15)) });
    }
  }

  return { sensor: "CO2", unit: "ppm", intervalSec, durationSec, points, events };
}

// ── 실험 2: 밀폐 용기 속 식물 CO₂ (ppm) ─────────────────
function mockExp2(condition) {
  const intervalSec = 10;
  const durationSec = 20 * 60;
  const points = [];

  // 조건 이름은 학생이 직접 정하므로 낱말로 어림해 시나리오를 고른다
  let start, target, tau;
  if (/어두|암|없/.test(condition)) {
    // 빛 없음: 호흡만 → CO₂가 천천히 늘어난다 (약 8 ppm/분)
    start = 750 + noise(40); target = 950; tau = 1500;
  } else if (/밝|강|직사/.test(condition)) {
    // 밝음: 광합성이 호흡보다 훨씬 커서 빠르게 줄어든다 (약 24 ppm/분)
    start = 780 + noise(40); target = 380; tau = 1000;
  } else {
    // 보통: 완만하게 줄어든다 (약 11 ppm/분)
    start = 770 + noise(40); target = 520; tau = 1400;
  }
  for (let t = 0; t <= durationSec; t += intervalSec) {
    points.push({ t, v: Math.round(approach(start, target, t, tau) + noise(8)) });
  }
  return { sensor: "CO2", unit: "ppm", intervalSec, durationSec, points, events: [] };
}

// ── 실험 3: 심박수 (bpm) ────────────────────────────────
function mockExp3(condition) {
  const intervalSec = 5;
  const durationSec = 6 * 60;
  const points = [];
  const base = 70 + noise(5); // 사람마다 다른 안정 시 심박수

  let start, tau;
  if (condition === "안정 시") {
    start = base; tau = 1; // 변화 없음
  } else if (condition === "가벼운 운동 후") {
    start = 115 + noise(10); tau = 80;
  } else {
    // "심한 운동 후"와 "회복 ○분"은 모두 높은 값에서 회복하는 곡선
    start = 158 + noise(12); tau = 140;
  }
  for (let t = 0; t <= durationSec; t += intervalSec) {
    points.push({ t, v: round1(approach(start, base + 2, t, tau) + noise(2)) });
  }
  return { sensor: "HeartRate", unit: "bpm", intervalSec, durationSec, points, events: [] };
}

// ── 실험 4: 물·식용유 가열 온도 (℃) ─────────────────────
// 비열이 큰 물이 천천히 데워진다. 물 약 4.2, 식용유 약 2.0 J/g℃이므로
// 같은 열을 주면 식용유가 대략 2배 빠르게 오른다.
function mockExp4(condition) {
  const intervalSec = 10;
  const durationSec = 10 * 60;
  const points = [];
  const start = 22 + noise(1); // 실온에서 시작

  // 식용유는 물보다 약 2.1배 빠르게 상승 (물 3.2℃/분, 식용유 6.7℃/분)
  const isOil = /기름|식용유|유/.test(condition);
  // 가열이 이어지면 열이 빠져나가 조금씩 완만해지므로 approach 곡선을 쓴다
  const tau = 3000;
  const target = start + (isOil ? 335 : 160); // 초기 기울기를 위 값으로 맞춘 목표

  for (let t = 0; t <= durationSec; t += intervalSec) {
    points.push({ t, v: round1(approach(start, target, t, tau) + noise(0.3)) });
  }
  return { sensor: "Temperature", unit: "℃", intervalSec, durationSec, points, events: [] };
}

// ── 공개 함수 ───────────────────────────────────────────
// generateMock(expNo, condition) → Dataset (SPEC §7 시그니처)
export function generateMock(expNo, condition) {
  const gen = { 1: mockExp1, 2: mockExp2, 3: mockExp3, 4: mockExp4 }[expNo];
  if (!gen) throw new Error(`알 수 없는 실험 번호: ${expNo}`);
  const { sensor, unit, intervalSec, durationSec, points, events } = gen(condition || "");

  return {
    expNo,
    groupId: "",              // 비워 둔다 — saveDataset()이 입장한 모둠으로 채운다
    ownerUid: "",             // 비워 둔다 — saveDataset()이 로그인 uid로 채운다
    title: `${condition || "기본"} 연습 측정`,
    condition: condition || "",
    sensor,
    unit,
    startedAt: new Date(Date.now() - durationSec * 1000),
    intervalSec,
    points,
    events,
    source: "mock",
    status: "draft",
    createdAt: new Date(),
  };
}

// 실험별로 시나리오가 준비된 조건 목록 (홈·개발용 참고)
export const MOCK_CONDITIONS = {
  1: ["창문 닫음", "창문 열음", "쉬는 시간", "문만 열음"],
  2: ["어두움", "보통", "밝음"],
  3: ["안정 시", "가벼운 운동 후", "심한 운동 후"],
  4: ["물", "식용유"],
};
