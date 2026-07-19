// js/router.js — 해시 기반 탭 전환 (세션 A)
//
// 주소 규칙 (SPEC §6.1): #home, #exp1, #exp2, #exp3
//
// 실험 탭 모듈(세션 B·C·D)이 지켜야 할 약속:
//   js/exp1.js 등에서 `export function mount(containerEl)` 를 내보낸다.
//   탭이 열릴 때마다 mount가 호출된다. containerEl은 비워진 상태로 넘어온다.
//   모듈 파일이 아직 없으면 "준비 중" 화면이 대신 나온다.

const tabs = new Map(); // id → { label, mount }
let navEl = null;
let outletEl = null;

// 탭을 등록한다. mount 없이 등록하면 "준비 중" 자리만 잡는다.
// 같은 id로 다시 부르면 덮어쓴다 (동적 로드 성공 시 업그레이드용).
export function registerTab(id, { label, mount }) {
  tabs.set(id, { label, mount });
  if (navEl) renderNav();       // 이미 화면이 떠 있으면 탭 줄을 새로 그린다
  if (outletEl && currentId() === id) show(id); // 지금 보고 있는 탭이면 즉시 갱신
}

// 라우터 시작. nav(탭 줄)와 outlet(내용 영역)을 받는다.
export function startRouter({ nav, outlet }) {
  navEl = nav;
  outletEl = outlet;
  window.addEventListener("hashchange", () => show(currentId()));
  renderNav();
  show(currentId());
}

function currentId() {
  const id = location.hash.replace("#", "");
  return tabs.has(id) ? id : "home";
}

function renderNav() {
  navEl.innerHTML = "";
  for (const [id, tab] of tabs) {
    const a = document.createElement("a");
    a.href = "#" + id;
    a.textContent = tab.label;
    a.className = "tab" + (id === currentId() ? " active" : "");
    navEl.append(a);
  }
}

function show(id) {
  renderNav();
  outletEl.innerHTML = "";
  const tab = tabs.get(id);
  if (tab?.mount) {
    tab.mount(outletEl);
  } else {
    // 담당 세션이 아직 파일을 만들지 않은 탭
    const box = document.createElement("div");
    box.className = "placeholder";
    box.innerHTML = `<p class="placeholder-emoji">🛠️</p>
      <p><strong>${tab?.label || id}</strong> 화면은 아직 준비 중이에요.</p>
      <p>조금만 기다려 주세요!</p>`;
    outletEl.append(box);
  }
}
