import { escapeText } from "./utils.js";
// js/annotations.js — 사건 메모선 입력칸 + 목록 (세션 A 공통)
//
// 학생이 그래프를 눌러 "그 시각에 무슨 일이 있었는지" 한 줄 메모를 남기는 기능.
// 실험 1의 화면(세션 B)에서 검증된 코드를 실험 2·3·4가 함께 쓰도록 옮겨 놓은 것이다.
//
// ★ 저장 위치는 analysis.annotations = [{ t, label }] 하나뿐이다 (SPEC §5.1 v2.4).
//   수집기가 기록한 datasets.events(원본)는 절대 건드리지 않는다 (절대 규칙 6).
//   그래프에서 원본 사건선은 회색, 학생 메모선은 빨강으로 구분된다.
// ★ prompt()·alert()·confirm()을 쓰지 않는다. 모두 화면 안 입력칸으로 처리한다.
//
// ── 쓰는 법 ────────────────────────────────────────────
//
//   import { mountAnnotations } from "./annotations.js";
//
//   // 1) 메모칸과 목록이 들어갈 자리를 화면에 하나 만들어 둔다
//   slotEl.innerHTML = `<div class="chartbox"><canvas></canvas></div>
//                       <div id="exp2-anno"></div>`;
//
//   // 2) 그 자리에 붙인다 (한 번만)
//   const anno = mountAnnotations(slotEl.querySelector("#exp2-anno"), {
//     analysis,                       // getAnalysis()가 준 객체
//     onSave:   (a) => saveAnalysis(a),
//     onChange: () => draw(),         // 메모가 늘거나 줄면 그래프를 다시 그린다
//     placeholder: "예) 물 붓기",     // 실험마다 다른 예시 문구
//   });
//
//   // 3) 그래프를 누르면 그 시각의 입력칸이 열리게 연결한다
//   function draw() {
//     drawChart(canvasEl, { ...opts, onPickTime: anno.openAt });
//     anno.refresh();
//   }
//
// ── 넘기는 값 ──────────────────────────────────────────
//   hostEl      : 입력칸과 목록을 그릴 자리. 안의 내용은 지워지고 새로 그려진다
//   analysis    : getAnalysis()가 준 객체. analysis.annotations를 직접 읽고 고친다
//                 (없으면 빈 배열로 만들어 준다)
//   onSave      : (analysis) => {}   메모가 바뀔 때마다 부른다. 저장 함수를 넘겨라
//   onChange    : () => {}           메모가 추가·삭제됐을 때 부른다.
//                                    이 신호로 그래프를 다시 그리면 된다
//   placeholder : (선택) 입력칸 예시 문구. 안 주면 무난한 기본값을 쓴다
//
// ── 돌려받는 것 ────────────────────────────────────────
//   openAt(t) : 경과 t초에 대한 라벨 입력칸을 연다.
//               chart-kit의 onAddAnnotation(=onPickTime) 콜백에 그대로 넘기면 된다
//   refresh() : 메모 목록만 다시 그린다 (그래프를 다시 그린 뒤에 부른다)
//   close()   : 열려 있는 입력칸을 닫는다.
//               막대그래프로 바꿨을 때처럼 더 이상 메모를 찍을 수 없게 된 경우에 부른다
//
// 주의: 막대그래프에는 시간축이 없어 메모선을 찍을 수 없다. 선그래프일 때만
//       openAt을 연결할지는 각 실험 탭이 판단한다 (이 모듈은 상관하지 않는다).

const DEFAULT_PLACEHOLDER = "예) 창문 열기";

export function mountAnnotations(hostEl, { analysis, onSave, onChange, placeholder } = {}) {
  if (!hostEl) return { openAt() {}, refresh() {}, close() {} };
  injectStyleOnce();

  // 없으면 만들어 둔다 — 이 배열 하나가 학생 메모의 유일한 저장 위치다
  if (!Array.isArray(analysis.annotations)) analysis.annotations = [];

  const hint = placeholder || DEFAULT_PLACEHOLDER;
  const save = () => (typeof onSave === "function" ? onSave(analysis) : undefined);
  const changed = () => (typeof onChange === "function" ? onChange() : undefined);

  hostEl.innerHTML = "";
  hostEl.classList.add("anno");
  const formEl = elem("div", "anno-form-slot");
  const listEl = elem("div", "anno-list-slot");
  hostEl.append(formEl, listEl);

  // ── 입력칸 열기 ──────────────────────────────────────
  // 그래프를 누른 시각(경과 초)에 대한 한 줄 메모를 받는다.
  function openAt(t) {
    const sec = Math.round(t || 0);
    formEl.innerHTML = `
      <div class="anno-form">
        <label for="anno-text"><b>${formatTime(sec)}</b>에 무슨 일이 있었나요?</label>
        <div class="anno-row">
          <input type="text" id="anno-text" maxlength="20" placeholder="${escapeText(hint)}">
          <button type="button" class="anno-add">메모선 남기기</button>
          <button type="button" class="anno-ghost anno-cancel">그만두기</button>
        </div>
        <p class="anno-msg"></p>
      </div>`;
    const input = formEl.querySelector("#anno-text");
    input.focus();

    const add = () => {
      const label = input.value.trim();
      if (!label) {
        formEl.querySelector(".anno-msg").textContent = "무슨 일이 있었는지 한 줄만 적어 주세요.";
        input.focus();
        return;
      }
      analysis.annotations.push({ t: sec, label });     // t는 경과 "초" (반올림한 값)
      analysis.annotations.sort((a, b) => a.t - b.t);   // 시간 순서대로
      save();
      close();
      refresh();
      changed();
    };

    formEl.querySelector(".anno-add").addEventListener("click", add);
    formEl.querySelector(".anno-cancel").addEventListener("click", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") add();
      if (e.key === "Escape") close();
    });
  }

  function close() {
    formEl.innerHTML = "";
  }

  // ── 목록 그리기 ──────────────────────────────────────
  // 지우기 단추가 반드시 있어야 한다 — 화면 힌트가 "메모 목록에서 지울 수 있어요"라고
  // 안내하고 있으므로, 목록이 없으면 그 문구가 거짓말이 된다.
  function refresh() {
    const notes = analysis.annotations;
    if (!notes.length) {
      listEl.innerHTML = `<p class="anno-dim">그래프를 누르면 그 시각에 빨간 메모선을 남길 수 있어요.</p>`;
      return;
    }
    listEl.innerHTML = `<p class="anno-dim">내가 단 메모선</p>
      <ul class="anno-ul">${notes
        .map(
          (a, i) => `<li><b>${formatTime(a.t)}</b> · ${escapeText(a.label)}
            <button type="button" class="anno-ghost" data-i="${i}">지우기</button></li>`
        )
        .join("")}</ul>`;
    listEl.querySelectorAll("button[data-i]").forEach((btn) => {
      btn.addEventListener("click", () => {
        analysis.annotations.splice(Number(btn.dataset.i), 1);
        save();
        refresh();
        changed();
      });
    });
  }

  refresh();
  return { openAt, refresh, close };
}

// ── 도우미 ──────────────────────────────────────────────

// 학생이 쓴 글자를 화면에 넣기 전에 태그로 읽히지 않게 한다

// 경과 초 → 사람이 읽는 "3분 20초" (raw-data.js·chart-kit 말풍선과 같은 형식)
function formatTime(sec) {
  sec = Math.round(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}분 ${String(s).padStart(2, "0")}초`;
}

function elem(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// 이 모듈이 쓰는 스타일을 <head>에 한 번만 넣는다 (style.css를 건드리지 않기 위해).
function injectStyleOnce() {
  if (document.getElementById("annotations-style")) return;
  const s = document.createElement("style");
  s.id = "annotations-style";
  s.textContent = `
    .anno .anno-form { border:1px solid #fca5a5; background:#fef2f2; border-radius:8px; padding:8px 12px; margin:6px 0; }
    .anno .anno-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:6px; }
    .anno .anno-row input { flex:1 1 180px; padding:4px 8px; }
    .anno .anno-msg { color:#b91c1c; font-size:14px; margin:4px 0 0; }
    .anno .anno-dim { color:#777; font-size:14px; margin:4px 0; }
    .anno .anno-ul { list-style:none; padding:0; margin:4px 0; }
    .anno .anno-ul li { padding:3px 0; border-bottom:1px dashed #eee; }
    .anno .anno-ul li b { color:#dc2626; }
    .anno .anno-ghost { background:none; border:1px solid #ccc; border-radius:6px; color:#555;
      font-size:13px; padding:2px 8px; margin-left:6px; cursor:pointer; }
    .anno .anno-ghost:hover { background:#f3f4f6; }
    .anno .anno-add { background:#dc2626; color:#fff; border:none; border-radius:6px;
      font-size:14px; padding:4px 12px; cursor:pointer; }
    .anno .anno-add:hover { background:#b91c1c; }
  `;
  document.head.append(s);
}
