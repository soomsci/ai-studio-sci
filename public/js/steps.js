// js/steps.js — 분석 5단계 공통 틀 (세션 A)
//
// 실험 탭(세션 B·C·D)은 renderSteps()만 호출한다. 단계 UI를 직접 만들지 않는다. (SPEC §7·§8)
//
// renderSteps(containerEl, stepConfig, analysis, onSave)
//   stepConfig: 각 실험 config의 steps 배열. 항목 형태 —
//     {
//       id: "s1",                 // answers 객체의 키
//       title: "데이터 살펴보기",
//       intro: "...",             // (선택) 단계 안내 한 줄
//       prompts: ["...", ...],    // 비계 질문 — 답을 알려주지 않는 질문만!
//       hints: ["...", ...],      // (선택) "더 힌트 보기"로 접어 두는 추가 힌트
//       placeholder: "...",       // (선택) 답변 칸 안내 문구
//       field: "conclusion",      // (선택) 답을 answers 대신 analysis.conclusion에 저장 (4단계용)
//       render: (slotEl, ctx) => {} // (선택) 그래프·자동 계산 등 실험별 내용을 끼울 자리
//                                   //  ctx = { analysis, stepIndex }
//     }
//   analysis: getAnalysis()로 받은 객체. 이 함수가 직접 고쳐 나간다.
//   onSave(analysis): 저장 함수. 입력 1초 후 자동 호출된다(디바운스).

export function renderSteps(containerEl, stepConfig, analysis, onSave) {
  analysis.answers = analysis.answers || {};
  analysis.aiLog = analysis.aiLog || [];
  let current = 0;
  let saveTimer = null;

  // 입력이 멈추고 1초 뒤 자동 저장 (SPEC §8.4 — "저장" 버튼을 두지 않는다)
  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => onSave(analysis), 1000);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    onSave(analysis);
  }

  function answerOf(step) {
    return step.field === "conclusion" ? analysis.conclusion || "" : analysis.answers[step.id] || "";
  }
  function setAnswer(step, text) {
    if (step.field === "conclusion") analysis.conclusion = text;
    else analysis.answers[step.id] = text;
  }

  function render() {
    containerEl.innerHTML = "";
    containerEl.classList.add("steps");
    containerEl.append(renderNav(), renderBody());
  }

  // 상단 단계 이동 버튼 (답을 쓴 단계에는 ✓ 표시)
  function renderNav() {
    const nav = el("div", "steps-nav");
    stepConfig.forEach((step, i) => {
      const done = answerOf(step).trim() !== "";
      const btn = el("button", "step-chip" + (i === current ? " active" : "") + (done ? " done" : ""),
        `${i + 1} ${step.title}` + (done ? " ✓" : ""));
      btn.type = "button";
      btn.addEventListener("click", () => { current = i; render(); });
      nav.append(btn);
    });
    return nav;
  }

  function renderBody() {
    const step = stepConfig[current];
    const body = el("section", "step-body");

    body.append(el("h3", "step-title", `${current + 1}단계 · ${step.title}`));
    if (step.intro) body.append(el("p", "step-intro", step.intro));

    // 실험별 내용(그래프·자동 계산)이 들어갈 자리
    if (typeof step.render === "function") {
      const slot = el("div", "step-slot");
      body.append(slot);
      step.render(slot, { analysis, stepIndex: current });
    }

    // 비계 질문
    if (step.prompts?.length) {
      const box = el("div", "prompt-box");
      box.append(el("p", "prompt-head", "💡 이런 걸 살펴보세요"));
      const ul = el("ul");
      step.prompts.forEach((p) => ul.append(el("li", null, p)));
      box.append(ul);
      body.append(box);
    }

    // 추가 힌트는 접어 둔다 — 처음부터 다 보이면 스스로 생각하지 않는다 (SPEC §12.2)
    if (step.hints?.length) {
      const det = el("details", "hint-box");
      det.append(el("summary", null, "🔍 더 힌트 보기"));
      const ul = el("ul");
      step.hints.forEach((h) => ul.append(el("li", null, h)));
      det.append(ul);
      body.append(det);
    }

    // 답변 칸 — 자동 저장
    const ta = el("textarea", "step-answer");
    ta.placeholder = step.placeholder || "우리 모둠이 발견한 것을 써 보세요";
    ta.value = answerOf(step);
    ta.addEventListener("input", () => {
      setAnswer(step, ta.value);
      queueSave();
    });
    body.append(ta);

    body.append(renderAiBox(step));
    body.append(renderFooter());
    return body;
  }

  // AI 활용 기록 (SPEC §8.5) — AI 답을 그대로 옮기지 말고 "기록"만 남긴다
  function renderAiBox(step) {
    const det = el("details", "ai-box");
    det.append(el("summary", null, `🤖 AI에게 물어봤다면 여기에 기록해요 (${analysis.aiLog.length}건)`));
    det.append(el("p", "ai-note", "AI의 답을 그대로 옮겨 쓰면 안 돼요. 무엇을 물었고, AI의 답이 우리 데이터와 맞는지 우리가 판단한 것을 남깁니다."));

    // 지금까지의 기록 목록
    if (analysis.aiLog.length) {
      const list = el("ul", "ai-list");
      analysis.aiLog.forEach((entry) => {
        const li = el("li");
        li.append(el("div", null, "물어본 것: " + entry.prompt));
        if (entry.summary) li.append(el("div", "ai-dim", "AI의 답(요약): " + entry.summary));
        const badge = el("span", "ai-verdict v-" + ({ "맞음": "ok", "다름": "no" }[entry.verdict] || "etc"),
          "우리 데이터와: " + entry.verdict);
        li.append(badge);
        if (entry.reason) li.append(el("div", "ai-dim", "판단한 까닭: " + entry.reason));
        list.append(li);
      });
      det.append(list);
    }

    // 새 기록 입력 폼
    const form = el("div", "ai-form");
    const qInput = el("input");
    qInput.placeholder = "AI에게 무엇을 물어봤나요?";
    const aInput = el("textarea");
    aInput.placeholder = "AI는 뭐라고 답했나요? (짧게 요약)";
    form.append(qInput, aInput);

    form.append(el("p", "ai-q", "AI의 답이 우리 데이터와 맞나요? (꼭 골라야 해요)"));
    const verdicts = el("div", "ai-verdicts");
    let picked = "";
    ["맞음", "다름", "판단 불가"].forEach((v) => {
      const b = el("button", "verdict-btn", v);
      b.type = "button";
      b.addEventListener("click", () => {
        picked = v;
        verdicts.querySelectorAll("button").forEach((x) => x.classList.toggle("picked", x === b));
      });
      verdicts.append(b);
    });
    form.append(verdicts);

    const rInput = el("input");
    rInput.placeholder = "다르거나 판단이 어려웠다면, 왜 그렇게 생각했나요?";
    form.append(rInput);

    const msg = el("p", "ai-msg", "");
    const addBtn = el("button", "btn small", "기록 남기기");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => {
      if (!qInput.value.trim()) { msg.textContent = "무엇을 물어봤는지 써 주세요."; return; }
      if (!picked) { msg.textContent = "우리 데이터와 맞는지 골라 주세요."; return; }
      analysis.aiLog.push({
        prompt: qInput.value.trim(),
        summary: aInput.value.trim(),
        verdict: picked,
        reason: rInput.value.trim(),
        at: new Date(),
      });
      saveNow();
      render(); // 목록을 새로 그린다
    });
    form.append(addBtn, msg);
    det.append(form);
    return det;
  }

  function renderFooter() {
    const foot = el("div", "step-foot");
    const prev = el("button", "btn ghost", "← 이전");
    prev.type = "button";
    prev.disabled = current === 0;
    prev.addEventListener("click", () => { current -= 1; render(); });

    const next = el("button", "btn", current === stepConfig.length - 1 ? "분석 끝! 🎉" : "다음 단계 →");
    next.type = "button";
    next.disabled = current === stepConfig.length - 1;
    // 답이 비어도 다음으로 갈 수 있다 — 강제하지 않는다 (SPEC §8.4)
    next.addEventListener("click", () => { current += 1; render(); });

    foot.append(prev, next);
    return foot;
  }

  render();
}

// 작은 DOM 도우미
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
