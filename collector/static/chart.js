// static/chart.js — 측정 중 실시간 그래프 (세션 F)
//
// Chart.js는 웹앱(public/index.html)도 쓰는 유일한 외부 라이브러리(CLAUDE.md
// 기술 규칙)라 CDN 그대로 쓴다. 다만 수업용 노트북이 인터넷에 못 붙으면 이
// CDN 스크립트가 안 불려서 Chart가 없을 수 있다 — 그래프만 건너뛰고 측정은
// 계속되게, 아래 함수는 항상 typeof Chart로 먼저 확인한다.

const CHART_COLORS = ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834", "#4a3aa7", "#e34948"];
let channelsChart = null;
let manualChart = null;

function chartAvailable() {
  return typeof Chart !== "undefined";
}

function toMinuteSeries(points) {
  return (points || []).map((p) => ({ x: p.t / 60, y: p.v }));
}

function updateChannelsChart(channels) {
  if (!chartAvailable() || channels.length === 0) return;
  if (!channelsChart) {
    channelsChart = new Chart(document.getElementById("channelsChart"), {
      type: "line",
      data: { datasets: [] },
      options: {
        animation: false,
        parsing: false,
        scales: {
          x: { type: "linear", title: { display: true, text: "시간(분)" } },
          y: { title: { display: true, text: `측정값(${channels[0].unit})` } },
        },
        plugins: { legend: { display: true } },
      },
    });
  }
  channelsChart.data.datasets = channels.map((ch, i) => ({
    label: ch.label,
    data: toMinuteSeries(ch.points),
    borderColor: CHART_COLORS[i % CHART_COLORS.length],
    backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
    borderWidth: 2,
    pointRadius: 0,
    tension: 0,
  }));
  channelsChart.update("none"); // 애니메이션 없이 다시 그려서 점이 많아져도 안 느려지게
}

function updateManualChart(points, unit) {
  if (!chartAvailable()) return;
  if (!manualChart) {
    manualChart = new Chart(document.getElementById("manualChart"), {
      type: "line",
      data: {
        datasets: [{
          label: "측정값",
          data: [],
          borderColor: CHART_COLORS[0],
          backgroundColor: CHART_COLORS[0],
          borderWidth: 2,
          pointRadius: 3,
          tension: 0,
        }],
      },
      options: {
        animation: false,
        parsing: false,
        scales: {
          x: { type: "linear", title: { display: true, text: "시간(분)" } },
          y: { title: { display: true, text: unit ? `측정값(${unit})` : "측정값" } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }
  manualChart.data.datasets[0].data = toMinuteSeries(points);
  manualChart.update("none");
}

async function refreshManualChart() {
  const res = await fetch("/api/status");
  const data = await res.json();
  if (data.ok && data.points) {
    const opt = document.getElementById("manualSensorSelect").selectedOptions[0];
    updateManualChart(data.points, opt ? opt.dataset.unit : "");
  }
}
