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
  document.getElementById("btnStart").disabled = measuring || currentChannelCount === 0;
  document.getElementById("btnStop").disabled = !measuring;
  document.getElementById("btnEvent").disabled = !measuring;
  document.getElementById("btnScan").disabled = measuring;
  document.getElementById("btnAddChannel").disabled = measuring;
  document.getElementById("measureStatus").hidden = !measuring;
}

function renderChannels(channels, status = currentMeasurementStatus) {
  currentChannelCount = channels.length;
  const list = document.getElementById("channelList");
  list.innerHTML = "";
  channels.forEach((ch) => {
    const li = document.createElement("li");
    const value = ch.latestValue == null ? "" : `${ch.latestValue} ${ch.unit}`;
    li.innerHTML = `<span class="num">${ch.deviceId}</span>${ch.label} — ${ch.title}` +
      `<span class="count">${ch.count}개 모음</span>` +
      `<span class="val">${value}</span>`;
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
      if (data.status !== "measuring") {
        clearInterval(pollTimer);
      }
    }
  }, 800);
}
