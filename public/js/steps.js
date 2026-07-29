// js/steps.js — 분석 5단계 공통 틀 (세션 A)
//
// 실험 탭(세션 B·C·D)은 renderSteps()만 호출한다. 단계 UI를 직접 만들지 않는다. (SPEC §7·§8)
//
// renderSteps(containerEl, stepConfig, analysis, onSave, onCompleteChange?)
//   stepConfig: 각 실험 config의 steps 배열. 두 종류의 단계가 있다.
//
//   (가) 자유 글쓰기 단계 (기본)
//     {
//       id: "s1",                 // answers 객체의 키
//       title: "데이터 살펴보기",
//       intro: "...",             // (선택) 단계 안내 한 줄
//       prompts: ["...", ...],    // 비계 질문 — 답을 알려주지 않는 질문만!
//       hints: ["...", ...],      // (선택) "더 힌트 보기"로 접어 두는 추가 힌트
//       placeholder: "...",       // (선택) 답변 칸 안내 문구
//       field: "conclusion",      // (선택) 답을 answers 대신 analysis.conclusion에 저장 (4단계용)
//       render: (slotEl, ctx) => {} // (선택) 그래프·자동 계산 등 실험별 내용을 끼울 자리
//     }
//
//   (나) 선택 관문 단계 — 정답을 골라야 넘어간다 (축 고르기 퀴즈 등)
//     {
//       id: "g1", type: "choice", title: "...", intro: "...",
//       // 질문 하나:
//       prompt: "가로축에는 무엇이 들어갈까요?",
//       options: ["시간","CO2 농도","온도"], answer: "시간",
//       hint: "측정하는 동안 계속 흘러간 것을 떠올려 보세요.",
//       // 또는 한 단계에 여러 질문(가로축·세로축 등):
//       choices: [ { id:"x", prompt, options, answer, hint },
//                  { id:"y", prompt, options, answer, hint } ],
//     }
//     · 정답 문구는 config가 주는 것을 그대로 쓴다(실험마다 다르므로 하드코딩 금지).
//     · 골라 넘긴 답은 자유 글쓰기와 같은 방식으로 analysis.answers에 저장된다.
//       (질문이 하나면 키는 step.id, 여러 개면 choice.id)
//     · 관문 진행 상태(맞힘/시도횟수/통과)는 analysis.gates에 따로 둔다.
//
//   analysis: getAnalysis()로 받은 객체. 이 함수가 직접 고쳐 나간다.
//   onSave(analysis): 저장 함수. 입력 1초 후 자동 호출된다(디바운스).
//   onCompleteChange(complete): (선택) 모든 단계 완료 여부가 바뀔 때 호출.
//       설계 단계를 렌더한 실험 코드가 이 신호로 측정 영역을 열고 닫는다.
//
// isStepsComplete(stepConfig, analysis) → boolean 도 함께 export 한다(아래).

export function renderSteps(containerEl, stepConfig, analysis, onSave, onCompleteChange) {
  analysis.answers = analysis.answers || {};
  analysis.aiLog = analysis.aiLog || [];
  analysis.gates = analysis.gates || {}; // 선택 관문 진행 상태
  let current = 0;
  let saveTimer = null;
  let lastComplete = isStepsComplete(stepConfig, analysis);

  // 입력이 멈추고 1초 뒤 자동 저장 (SPEC §8.4 — "저장" 버튼을 두지 않는다)
  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => onSave(analysis), 1000);
    maybeNotifyComplete();
  }
  function saveNow() {
    clearTimeout(saveTimer);
    onSave(analysis);
    maybeNotifyComplete();
  }

  // 완료 여부가 직전과 달라졌을 때만 콜백을 부른다
  function maybeNotifyComplete() {
    if (typeof onCompleteChange !== "function") return;
    const now = isStepsComplete(stepConfig, analysis);
    if (now !== lastComplete) {
      lastComplete = now;
      onCompleteChange(now);
    }
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
      const done = stepComplete(step, analysis); // 글쓰기·선택 관문 모두 판정
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

    if (step.type === "choice") {
      // 선택 관문: 정답을 골라야 넘어간다
      body.append(renderChoices(step));
    } else {
      // 자유 글쓰기 답변 칸 — 자동 저장
      const ta = el("textarea", "step-answer");
      ta.placeholder = step.placeholder || "우리 모둠이 발견한 것을 써 보세요";
      ta.value = answerOf(step);
      ta.addEventListener("input", () => {
        setAnswer(step, ta.value);
        queueSave();
      });
      body.append(ta);
    }

    body.append(renderAiBox(step));
    body.append(renderFooter());
    return body;
  }

  // 선택 관문 렌더링. 한 단계에 질문이 하나 또는 여러 개 있을 수 있다.
  function renderChoices(step) {
    const wrap = el("div", "choices");
    choicesOf(step).forEach((c) => wrap.append(renderChoice(c)));
    return wrap;
  }

  // 질문 하나: 물음 + 보기 버튼들 + 채점 안내.
  // 완전 차단하지 않는다(SPEC 결정): 틀리면 다시, 여러 번 틀리면 힌트,
  // 그래도 안 되면 통과시키되 "스스로 못 맞힘"을 남긴다 — 학생이 갇히지 않게.
  function renderChoice(c) {
    const box = el("div", "choice");
    const g = gateOf(analysis, c.key);
    if (c.prompt) box.append(el("p", "choice-prompt", c.prompt));

    const opts = el("div", "choice-opts");
    (c.options || []).forEach((opt) => {
      const b = el("button", "choice-opt", opt);
      b.type = "button";
      // 이미 맞힌 질문은 정답만 표시하고 잠근다
      if (g.correct) {
        if (opt === c.answer) b.classList.add("correct");
        b.disabled = true;
      } else if (g.picked === opt) {
        b.classList.add("picked");
      }
      b.addEventListener("click", () => pickChoice(c, opt));
      opts.append(b);
    });
    box.append(opts);

    box.append(el("p", "choice-msg " + (g.correct ? "ok" : g.passed ? "passed" : "no"),
      choiceMessage(c, g)));

    // 힌트는 여러 번 틀렸을 때만 보여준다 (처음부터 보이면 스스로 생각하지 않는다)
    if (c.hint && (g.attempts >= HINT_AFTER || g.passed) && !g.correct) {
      box.append(el("p", "choice-hint", "🔍 " + c.hint));
    }
    return box;
  }

  function pickChoice(c, opt) {
    const g = gateOf(analysis, c.key);
    if (g.correct) return; // 이미 맞힘 — 잠금
    g.picked = opt;
    analysis.answers[c.key] = opt; // 고른 답도 다른 단계처럼 저장

    if (opt === c.answer) {
      g.correct = true;
    } else {
      g.attempts += 1;
      // 여러 번 틀리면 통과시키되 스스로 못 맞힘을 남긴다
      if (g.attempts >= PASS_AFTER) g.passed = true;
    }
    saveNow();  // 완료 여부 재판정 포함
    render();
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

    const isLast = current === stepConfig.length - 1;
    const next = el("button", "btn", isLast ? "분석 끝! 🎉" : "다음 단계 →");
    next.type = "button";
    // 답이 비어도 다음으로 갈 수 있다 — 강제하지 않는다 (SPEC §8.4)
    next.addEventListener("click", () => {
      if (isLast) { saveNow(); return; } // 마지막 단계: 더 넘어갈 곳이 없으니 저장만 확실히 한다
      current += 1;
      render();
    });

    foot.append(prev, next);
    return foot;
  }

  render();
}

// 선택 관문 규칙 (SPEC 확정): 3번째 틀림부터 힌트, 4번째부터 통과 처리
const HINT_AFTER = 3;
const PASS_AFTER = 4;

// 한 선택 관문 단계의 질문 목록을 표준 형태로 편다.
// 질문이 여러 개면 step.choices, 하나면 step 자체에 적힌 필드를 쓴다.
// key = answers 저장 키(하나면 step.id, 여러 개면 choice.id).
function choicesOf(step) {
  if (Array.isArray(step.choices) && step.choices.length) {
    return step.choices.map((c) => ({ ...c, key: c.id || step.id }));
  }
  return [{ prompt: step.prompt, options: step.options, answer: step.answer, hint: step.hint, key: step.id }];
}

// 관문 진행 상태를 꺼낸다(없으면 만든다). analysis.gates에 질문별로 쌓인다.
function gateOf(analysis, key) {
  analysis.gates = analysis.gates || {};
  return (analysis.gates[key] = analysis.gates[key] || { picked: "", correct: false, attempts: 0, passed: false });
}

// 채점 안내 문구 — 정답을 알려주지 않는다
function choiceMessage(c, g) {
  if (g.correct) return "정답이에요! 👍";
  if (g.passed) return "스스로 못 맞혔지만 넘어갈 수 있어요. 힌트를 보고 다시 생각해 봐요.";
  if (g.attempts >= HINT_AFTER) return "힌트를 보고 다시 골라 보세요.";
  if (g.attempts > 0) return "다시 골라 보세요.";
  return "정답을 골라 보세요.";
}

// ── 완료 판정 (실험 코드가 측정 영역을 열고 닫는 신호로 쓴다) ──

function isChoiceStep(step) { return step.type === "choice"; }

// 선택 관문 완료: 모든 질문을 맞혔거나 통과 처리됐으면 완료
function choiceComplete(step, analysis) {
  return choicesOf(step).every((c) => {
    const g = analysis.gates && analysis.gates[c.key];
    return !!g && (g.correct || g.passed);
  });
}

// 글쓰기 완료: 답이 비어 있지 않으면 완료
function writingComplete(step, analysis) {
  const text = step.field === "conclusion"
    ? (analysis.conclusion || "")
    : (analysis.answers && analysis.answers[step.id]) || "";
  return text.trim() !== "";
}

// 단계 하나가 완료됐는가
export function stepComplete(step, analysis) {
  return isChoiceStep(step) ? choiceComplete(step, analysis) : writingComplete(step, analysis);
}

// 이 steps 묶음이 전부 완료됐는가 (설계 단계 → 측정 열기 판정 등)
export function isStepsComplete(stepConfig, analysis) {
  return (stepConfig || []).every((step) => stepComplete(step, analysis));
}

// 작은 DOM 도우미
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
