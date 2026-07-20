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
// 측정은 웹앱이 아니라 선생님이 나눠 준 별도 프로그램(센서 측정 도구)에서 한다.
// 그 프로그램이 학급 아이디·모둠 아이디를 물어보는데, 학생은 이 값을 알 방법이 없으므로
// 여기서 그대로 보여 주고 복사 단추를 붙인다. (학급 아이디는 외워 옮길 수 없는 문자열이다)
function sensorGuide(session) {
  const box = document.createElement("details");
  box.className = "sensor-guide";

  const summary = document.createElement("summary");
  summary.textContent = "🔌 센서로 직접 측정하려면? (눌러서 펼치기)";
  box.append(summary);

  box.append(div("guide-text",
    "측정은 이 화면이 아니라 선생님이 나눠 준 센서 측정 도구에서 해요. " +
    "그 프로그램을 열면 학급 아이디와 모둠 아이디를 물어봐요. 아래 값을 복사해서 붙여넣으세요."));

  box.append(idRow("우리 학급 아이디", session.classId));
  box.append(idRow("우리 모둠 아이디", session.groupId));

  box.append(div("guide-note",
    "센서가 없어도 괜찮아요. 각 실험 탭에서 연습 데이터를 만들면 분석하는 방법을 그대로 익힐 수 있어요."));
  return box;
}

// 아이디 한 줄: 이름 + 값 + 복사 단추
function idRow(label, value) {
  const row = div("id-row");
  row.append(div("id-label", label));

  const valueEl = div("id-value", value);
  row.append(valueEl);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn small copy-btn";
  btn.textContent = "복사";
  btn.addEventListener("click", async () => {
    if (await copyText(value, valueEl)) {
      btn.textContent = "복사됨!";
      btn.classList.add("copied");
    } else {
      // 복사가 막힌 환경에서는 값을 선택해 주어 학생이 직접 복사할 수 있게 한다
      btn.textContent = "위 글자를 복사하세요";
      selectText(valueEl);
    }
    setTimeout(() => { btn.textContent = "복사"; btn.classList.remove("copied"); }, 2000);
  });
  row.append(btn);
  return row;
}

// 브라우저마다 복사 방식이 막히는 경우가 달라 두 가지를 차례로 시도한다.
// 어느 쪽도 안 되면 false를 돌려주어 "직접 복사하세요" 안내가 뜨게 한다.
async function copyText(text, node) {
  try {
    // 응답이 없는 브라우저가 있어 1초만 기다린다 (안 그러면 단추가 아무 반응도 못 한다)
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error("시간 초과")), 1000)),
    ]);
    return true;
  } catch {
    // 옛 방식으로 한 번 더 시도
    try {
      selectText(node);
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

function selectText(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
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
