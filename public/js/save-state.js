// 저장 순서를 지키고 실패한 최신 답변을 메모리에 남긴다.
const pending = new Map();
let statusEl;

export function hasUnsavedChanges() { return pending.size > 0; }

function showPendingStatus() {
  if ([...pending.values()].some((state) => state.failed)) {
    showStatus("저장하지 못했어요. 답변은 이 화면에 남아 있어요. ", true);
  } else showStatus(pending.size ? "저장 중…" : "저장됨");
}

function showStatus(text, failed = false) {
  if (typeof document === "undefined") return;
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.className = "save-status";
    statusEl.setAttribute("role", "status");
    document.body.append(statusEl);
  }
  statusEl.textContent = text;
  if (failed) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "다시 저장하기";
    retry.addEventListener("click", () => flushSaves());
    statusEl.append(retry);
  }
}

export function scheduleSave(key, value, write, delay = 0) {
  let state = pending.get(key);
  if (!state) {
    state = { version: 0, running: null, timer: null };
    pending.set(key, state);
  }
  state.value = structuredClone(value);
  state.write = write;
  state.version++;
  state.failed = false;
  clearTimeout(state.timer);
  showPendingStatus();
  if (delay) {
    state.timer = setTimeout(() => runSave(key, state), delay);
    return Promise.resolve(true);
  }
  return runSave(key, state);
}

async function runSave(key, state) {
  clearTimeout(state.timer);
  state.timer = null;
  if (state.running) return state.running;
  state.running = Promise.resolve().then(async () => {
    try {
      let version;
      do {
        version = state.version;
        await state.write(state.value);
      } while (version !== state.version);
      clearTimeout(state.timer);
      state.timer = null;
      pending.delete(key);
      showPendingStatus();
      return true;
    } catch (error) {
      console.error("답변 저장 실패", error);
      state.failed = true;
      showPendingStatus();
      return false;
    } finally {
      state.running = null;
    }
  });
  return state.running;
}

export async function flushSaves() {
  const results = await Promise.all([...pending].map(([key, state]) => runSave(key, state)));
  return results.every(Boolean);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}
