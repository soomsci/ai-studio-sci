// js/home.js — 홈 화면 (세션 A)
//
// 구성 (SPEC §6.3):
//   - 학기 관통 질문 배너: 실험을 마칠 때마다 답 조각이 채워진다
//   - 요약 숫자 3개: 우리 모둠 측정 / 학급 전체 측정 / 우리가 만든 분석
//   - 실험 카드 3개: 제목·센서·진행 배지·우리 모둠 측정 건수 → 클릭하면 해당 탭으로

import { getSession } from "./auth.js";
import { listDatasets, listClassDatasets, getAnalysis, getClassInfo, MODE } from "./data.js";

const EXPS = [
  { no: 1, tab: "exp1", title: "우리 교실 최적 환기 주기 찾기", sensors: "CO₂ · 온도", piece: "① 교실에 쌓인다" },
  { no: 2, tab: "exp2", title: "교실 식물 최적 조건 찾기", sensors: "CO₂ · 밝기 · 온도", piece: "② 식물이 흡수한다" },
  { no: 3, tab: "exp3", title: "운동과 우리 몸", sensors: "심박수 · 폐활량 · CO₂", piece: "③ 우리 몸이 만든다" },
];

export async function mount(el) {
  const session = getSession();
  el.innerHTML = "";
  el.className = "home";

  // 연습 모드 안내
  if (MODE === "mock") {
    const notice = div("mock-notice",
      "🧪 지금은 연습 모드예요. 가짜 데이터로 화면을 써 볼 수 있고, 새로고침하면 쓴 내용이 사라져요.");
    el.append(notice);
  }

  // 학기 관통 질문 배너
  const banner = div("banner");
  banner.append(div("banner-q", "🌍 CO₂는 어디서 와서 어디로 갈까?"));
  const chips = div("banner-chips");
  banner.append(chips, div("banner-hint", "실험을 하나 마칠 때마다 답이 한 조각씩 채워져요"));
  el.append(banner);

  // 요약 숫자 3개 (데이터가 오면 채운다)
  const summary = div("summary");
  const numMine = statBox("우리 모둠 측정", "—");
  const numClass = statBox("학급 전체 측정", "—");
  const numAnalyses = statBox("우리가 만든 분석", "—");
  summary.append(numMine, numClass, numAnalyses);
  el.append(summary);

  // 센서 측정 안내 (평소엔 접혀 있어 자리를 적게 차지한다)
  if (session) el.append(sensorGuide(session));

  // 실험 카드 3개
  const cardsWrap = div("cards");
  const cards = EXPS.map((exp) => {
    const card = div("card");
    card.append(
      div("card-no", `실험 ${exp.no}`),
      div("card-title", exp.title),
      div("card-sensors", "사용 센서: " + exp.sensors),
      div("card-badge", "확인 중…"),
      div("card-count", ""),
    );
    card.addEventListener("click", () => { location.hash = exp.tab; });
    cardsWrap.append(card);
    return card;
  });
  el.append(cardsWrap);

  if (!session) return; // 입장 전이면 숫자 없이 틀만

  // 데이터 로드 (실험별 병렬)
  try {
    const [classInfo, ...perExp] = await Promise.all([
      getClassInfo(),
      ...EXPS.map((exp) => Promise.all([
        listDatasets(exp.no, session.groupId),
        listClassDatasets(exp.no),
        getAnalysis(exp.no, session.groupId),
      ])),
    ]);

    let mine = 0, all = 0, analyses = 0;
    perExp.forEach(([myList, classList, analysis], i) => {
      mine += myList.length;
      all += classList.length;
      const started = Object.values(analysis.answers || {}).some((a) => a.trim?.()) || analysis.conclusion;
      if (started) analyses += 1;

      // 카드 배지: 진행 중 / 준비 중 / 마침
      const exp = EXPS[i];
      const badge = cards[i].querySelector(".card-badge");
      if (classInfo.activeExp === exp.no) { badge.textContent = "지금 진행 중"; badge.classList.add("b-active"); }
      else if (classInfo.activeExp > exp.no) { badge.textContent = "마친 실험"; badge.classList.add("b-done"); }
      else { badge.textContent = "준비 중"; badge.classList.add("b-wait"); }
      cards[i].querySelector(".card-count").textContent =
        myList.length ? `우리 모둠 측정 ${myList.length}건` : "아직 측정이 없어요";

      // 배너 조각: 결론을 쓴 실험은 채워진다
      const chip = div("banner-chip" + (analysis.conclusion?.trim() ? " filled" : ""), exp.piece);
      chips.append(chip);
    });

    numMine.querySelector(".stat-num").textContent = mine;
    numClass.querySelector(".stat-num").textContent = all;
    numAnalyses.querySelector(".stat-num").textContent = analyses;
  } catch (err) {
    console.error(err);
    el.append(div("error-note", "데이터를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요."));
  }
}

// 센서로 직접 측정하는 방법 안내.
// 측정은 웹앱이 아니라 선생님이 나눠 준 별도 프로그램에서 한다.
// 그 프로그램이 학급 코드·모둠 번호를 물어보므로 여기서 그대로 보여 준다.
// (프로그램 실행 방법은 적지 않는다 — 배포 형태가 아직 정해지지 않았다)
function sensorGuide(session) {
  const box = document.createElement("details");
  box.className = "sensor-guide";

  const summary = document.createElement("summary");
  summary.textContent = "🔌 센서로 직접 측정하려면? (눌러서 펼치기)";
  box.append(summary);

  box.append(div("guide-text",
    "측정은 이 화면이 아니라 선생님이 나눠 준 센서 측정 프로그램에서 해요. " +
    "그 프로그램을 열면 학급 코드와 모둠 번호를 물어봐요. 아래 값을 그대로 넣으면 돼요."));

  box.append(codeRow("학급 코드", session.joinCode || "선생님께 물어보세요"));
  box.append(codeRow("모둠 번호", session.groupName));

  box.append(div("guide-note",
    "센서가 없어도 괜찮아요. 각 실험 탭에서 연습 데이터를 만들면 분석하는 방법을 그대로 익힐 수 있어요."));
  return box;
}

// 값 한 줄: 이름 + 값. 둘 다 짧아서 눈으로 보고 옮겨 적을 수 있으므로
// 복사 단추 대신 크고 또렷하게 보여 준다.
function codeRow(label, value) {
  const row = div("id-row");
  row.append(div("id-label", label));
  row.append(div("id-value", value));
  return row;
}

function div(className, text) {
  const node = document.createElement("div");
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function statBox(label, value) {
  const box = div("stat");
  const num = div("stat-num", value);
  box.append(num, div("stat-label", label));
  return box;
}
