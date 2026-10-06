// static/measure.js — 채널 목록 표시 + 측정 상태 폴링 (세션 F)
//
// /api/status를 자주(800ms) 불러서 그래프·채널 목록이 거의 실시간으로
// 갱신되게 한다. Chart.js가 없어도(오프라인) updateChannelsChart(static/
// chart.js) 안에서 건너뛰므로 여기는 그 걱정을 안 해도 된다.

let currentMeasurementStatus = "idle";
let currentChannelCount = 0;

function setMeasurementControls(status) {
  currentMeasurementStatus = status;
  const measuring = status === "measuring";
  const errored = status === "error";
  document.getElementById("btnStart").disabled = measuring || errored || currentChannelCount === 0;
  document.getElementById("btnStop").disabled = !measuring;
  document.getElementById("btnEvent").disabled = !measuring;
  document.getElementById("btnScan").disabled = measuring || errored;
  document.getElementById("btnAddChannel").disabled = measuring || errored;
  document.getElementById("btnDisconnect").disabled = measuring || currentChannelCount === 0;
  document.getElementById("measureStatus").hidden = !measuring;
}

function renderChannels(channels, status = currentMeasurementStatus) {
  currentChannelCount = channels.length;
  const list = document.getElementById("channelList");
  list.innerHTML = "";
  channels.forEach((ch) => {
    const li = document.createElement("li");
    const value = ch.latestValue == null ? "" : `${ch.latestValue} ${ch.unit}`;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = ch.deviceId;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = ch.count + "개 모음";
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = value;
    li.append(num, document.createTextNode(ch.label + " — " + ch.title), count, val);
    if (ch.error) {
      const error = document.createElement("span");
      error.className = "count";
      error.style.color = "#b00";
      error.textContent = ch.error;
      li.appendChild(error);
    }
    list.appendChild(li);
  });
  setMeasurementControls(status);
  updateChannelsChart(channels); // static/chart.js — CDN이 안 불려도 그 안에서 건너뛴다
  // ★ 안전장치 — 채널 하나라도 저장 한도(§5.2)에 가까워지면 알린다.
  document.getElementById("pointsWarning").hidden = !channels.some((ch) => ch.nearLimit);
}

let pollTimer = null;
function pollStatus() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (data.ok && data.channels) {
      renderChannels(data.channels, data.status);
      if (data.limitReached) showMsg("저장할 수 있는 5,000개를 모아 측정을 멈췄어요. 서버로 보내 주세요.");
      if (data.error) {
        showMsg(`${data.error} 지금까지 모은 값은 서버로 보내거나 연결 해제할 수 있어요.`, true);
      }
      if (data.status !== "measuring") {
        clearInterval(pollTimer);
      }
    }
  }, 800);
}

function clearMeasurementView() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  renderChannels([], "idle");
}
