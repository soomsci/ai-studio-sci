// js/phase-nav.js — 화면 상단 단계 전환 UI: 계획 → 측정 → 분석 (세션 A)
//
// 실험 탭(세션 B·C·D)이 "계획 → 측정 → 분석"을 한 화면에 세로로 쌓지 않고
// 단계별로 전환해 보여줄 때 이 모듈로 감싼다. steps.js가 분석 5단계 안에서
// 하는 이전/다음 패턴(SPEC §8.3)을 화면 단위로 한 번 더 두른 것이다.
// 화면 안(계획 단계·분석 5단계)은 지금처럼 steps.js의 renderSteps를 그대로 쓴다.
// 이 모듈은 그 바깥 — 화면을 넘기는 것만 담당한다.
//
// renderPhases(containerEl, phases)
//   phases: [{
//     id,                 // 화면 키. goTo()에 쓴다.
//     label,              // 상단 칩 글자 (예: "1. 계획")
//     render(slotEl),     // 이 화면으로 올 때마다 호출돼 slotEl을 채운다
//     isLocked,           // (선택) () => boolean. true면 이 화면으로 못 넘어간다
//     lockMsg,            // (선택) 잠겼을 때 보여줄 안내 문구
//   }, ...]
//
// 반환값 { refresh(), goTo(id) }
//   refresh(): 잠금 여부가 바뀌었을 때(계획을 다 채웠을 때 등) 상단 칩·다음 버튼의
//     잠금 표시를 다시 계산한다. 지금 보고 있는 화면의 내용은 다시 그리지 않는다 —
//     입력 중이던 답이나 그려 둔 그래프가 refresh 때문에 갑자기 리셋되면 안 되므로.
//   goTo(id): 코드에서 직접 화면을 옮길 때 쓴다(예: "측정하러 가기" 버튼).
//
// SPEC §8.4-A: 잠긴 화면도 감추지 않는다. 칩은 그대로 보이되 누를 수 없게(disabled) 둔다.
import { flushSaves } from "./save-state.js";

export function renderPhases(containerEl, phases) {
  let current = 0;

  containerEl.innerHTML = "";
  containerEl.classList.add("phases");
  const nav = el("div", "phase-nav");
  const body = el("div", "phase-body");
  const lockmsg = el("p", "phase-lockmsg");
  lockmsg.hidden = true;
  const foot = el("div", "phase-foot");
  containerEl.append(nav, lockmsg, body, foot);

  function locked(i) {
    return typeof phases[i].isLocked === "function" && phases[i].isLocked();
  }

  function renderNav() {
    nav.innerHTML = "";
    phases.forEach((phase, i) => {
      const isLocked = locked(i);
      const btn = el(
        "button",
        "phase-chip" + (i === current ? " active" : "") + (isLocked ? " locked" : ""),
        phase.label + (isLocked ? " 🔒" : "")
      );
      btn.type = "button";
      btn.disabled = isLocked;
      btn.addEventListener("click", () => goTo(phase.id));
      nav.append(btn);
    });
  }

  function renderBody() {
    body.innerHTML = "";
    const phase = phases[current];
    if (locked(current)) {
      // 정상적으로는 여기 오지 않는다(goTo가 잠긴 화면을 막는다) — 방어적으로만 둔다
      lockmsg.hidden = false;
      lockmsg.textContent = phase.lockMsg || "🔒 아직 열리지 않았어요.";
      return;
    }
    lockmsg.hidden = true;
    phase.render(body);
  }

  function renderFoot() {
    foot.innerHTML = "";
    const prev = el("button", "btn ghost", "← 이전 화면");
    prev.type = "button";
    prev.disabled = current === 0;
    prev.addEventListener("click", () => goTo(phases[current - 1].id));
    foot.append(prev);

    if (current < phases.length - 1) {
      const nextLocked = locked(current + 1);
      const next = el("button", "btn", "다음 화면 →");
      next.type = "button";
      next.disabled = nextLocked;
      next.addEventListener("click", () => goTo(phases[current + 1].id));
      foot.append(next);
      if (nextLocked && phases[current + 1].lockMsg) {
        foot.append(el("p", "phase-nextlock", phases[current + 1].lockMsg));
      }
    }
  }

  async function goTo(id) {
    const i = phases.findIndex((p) => p.id === id);
    if (i < 0 || locked(i)) return;
    if (!await flushSaves() || !containerEl.isConnected) return;
    current = i;
    renderNav();
    renderBody();
    renderFoot();
    containerEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function refresh() {
    renderNav();
    renderFoot();
  }

  renderNav();
  renderBody();
  renderFoot();

  return { refresh, goTo };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
