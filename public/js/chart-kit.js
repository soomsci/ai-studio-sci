// js/chart-kit.js — 공통 그래프 렌더러 (세션 A)
//
// Chart.js(CDN, 전역 Chart)를 감싼다. 세션 B·C·D는 이 파일 함수만 쓴다. (SPEC §7)
//
// renderChart(canvasEl, spec)
//   spec = {
//     type: "line" | "bar" | "scatter",
//     datasets:
//       line/scatter → [{ label, points: [{t, v}] 또는 [{x, y}], color? }]
//                      (t는 경과 "초" — 그래프에는 자동으로 "분"으로 바꿔 표시)
//       bar          → [{ label, value, color? }]   (항목 하나 = 막대 하나)
//     xLabel, yLabel: 축 이름 (한국어로),
//     refLine: { value, label, color },             // 수평 기준선
//     events: [{ t, label }],                       // 수직 사건 기록선 (t는 초)
//     tooltip: {                                    // 좌표 확인 말풍선 (SPEC §7.1)
//       timeFormat: "mmss" | "sec" | "clock",       //   "2분 05초" | "125초" | "02:05"
//       valueLabel: "CO2 농도",                      //   값 앞에 붙는 이름
//       valueUnit: "ppm",
//       extra: (point) => "",                       //   실험별 추가 줄. point = {t, v, x, y}
//     }
//   }
//
// 좌표 확인(§7.1)은 항상 켜져 있다: 마우스를 올리면(터치 기기는 탭)
// 가장 가까운 점이 강조되고 (시간, 값)이 말풍선으로 뜬다.
// spec.tooltip을 생략하면 축 이름과 기본 형식(mmss)으로 동작한다.

const PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0ea5e9", "#f97316", "#14b8a6"];
const charts = new WeakMap(); // 캔버스마다 기존 차트를 기억했다가 지우고 다시 그린다

export function renderChart(canvasEl, spec) {
  if (typeof Chart === "undefined") {
    throw new Error("Chart.js가 로드되지 않았어요. index.html의 CDN 태그를 확인하세요.");
  }
  charts.get(canvasEl)?.destroy();
  const chart = new Chart(canvasEl, buildConfig(spec));
  charts.set(canvasEl, chart);
  return chart;
}

// 그래프를 PNG 이미지(Blob)로 내보낸다. 배경은 흰색으로 채운다.
export function exportChartImage(canvasEl) {
  return new Promise((resolve, reject) => {
    const tmp = document.createElement("canvas");
    tmp.width = canvasEl.width;
    tmp.height = canvasEl.height;
    const ctx = tmp.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(canvasEl, 0, 0);
    tmp.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("이미지 변환에 실패했어요."))), "image/png");
  });
}

// ── 내부 구현 ───────────────────────────────────────────

function buildConfig(spec) {
  const { type = "line", datasets = [], xLabel, yLabel, refLine, events } = spec;

  let data;
  if (type === "bar") {
    data = {
      labels: datasets.map((d) => d.label),
      datasets: [{
        data: datasets.map((d) => d.value),
        backgroundColor: datasets.map((d, i) => d.color || PALETTE[i % PALETTE.length]),
      }],
    };
  } else {
    data = {
      datasets: datasets.map((d, i) => ({
        label: d.label,
        data: (d.points || []).map(toXY),
        borderColor: d.color || PALETTE[i % PALETTE.length],
        backgroundColor: d.color || PALETTE[i % PALETTE.length],
        showLine: type === "line",
        tension: 0.15,
        borderWidth: 2,
        // 점이 많은 시계열은 점을 숨겨 선만 보여준다 (읽기 쉬움)
        pointRadius: type === "line" && (d.points || []).length > 120 ? 0 : 3,
        // 마우스를 올리면 가장 가까운 점이 커지며 강조된다 (§7.1)
        pointHoverRadius: 6,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: "#ffffff",
      })),
    };
  }

  return {
    type: type === "line" ? "scatter" : type, // 선그래프도 x를 숫자축으로 쓰기 위해 scatter+showLine 사용
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      // 점 위가 아니라 "근처"에만 가도 가장 가까운 점이 잡히게 한다.
      // Chart.js 기본 이벤트에 touchstart/touchmove가 포함돼 터치 탭으로도 뜬다. (§7.1)
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: type === "bar" ? "category" : "linear",
          title: { display: !!xLabel, text: xLabel || "" },
        },
        y: {
          title: { display: !!yLabel, text: yLabel || "" },
        },
      },
      plugins: {
        legend: { display: type !== "bar" && datasets.length > 1 },
        tooltip: buildTooltip(spec),
        sdsMarkers: { refLine, events }, // 아래 커스텀 플러그인으로 전달
      },
    },
    plugins: [markerPlugin],
  };
}

// {t,v}(t=초) → {x(분), y}, 이미 {x,y}면 그대로
function toXY(p) {
  if (p.t !== undefined) return { x: p.t / 60, y: p.v };
  return { x: p.x, y: p.y };
}

// ── 좌표 확인 말풍선 (SPEC §7.1) ────────────────────────

// 경과 초 → 사람이 읽는 시간
function formatTime(sec, fmt) {
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (fmt === "sec") return `${sec}초`;
  if (fmt === "clock") return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}분 ${String(s).padStart(2, "0")}초`; // 기본 "mmss"
}

// 값을 읽기 좋게: 정수는 천 단위 쉼표, 소수는 한 자리까지
function formatValue(v) {
  if (!Number.isFinite(v)) return String(v);
  return (Number.isInteger(v) ? v : Math.round(v * 10) / 10).toLocaleString("ko-KR");
}

function buildTooltip(spec) {
  const { type = "line", tooltip: opt = {}, xLabel, yLabel, events } = spec;
  const valueLabel = opt.valueLabel || yLabel || "값";
  const unit = opt.valueUnit ? " " + opt.valueUnit : "";

  return {
    enabled: true,
    titleFont: { size: 14, weight: "bold" },  // 모둠 노트북에서 잘 보이게 13px 이상 (§7.1)
    bodyFont: { size: 14 },
    padding: 10,
    displayColors: false,
    callbacks: {
      // 첫 줄: 시간(시계열) / 조건명(막대) / 없음(산점도)
      title(items) {
        if (type === "bar") return items[0].label;
        if (type === "line") return formatTime(items[0].parsed.x * 60, opt.timeFormat);
        return "";
      },
      // 본문: 값 + 단위. 산점도는 두 축의 값을 나란히 보여준다.
      label(item) {
        const { x, y } = item.parsed;
        if (type === "bar") return `${valueLabel}: ${formatValue(y)}${unit}`;
        // 여러 데이터를 겹쳐 볼 때만 어느 줄인지 이름을 붙인다
        const many = item.chart.data.datasets.length > 1;
        const name = many && item.dataset.label ? item.dataset.label + " · " : "";
        if (type === "scatter") {
          return `${name}${xLabel || "가로축"}: ${formatValue(x)} · ${valueLabel}: ${formatValue(y)}${unit}`;
        }
        return `${name}${valueLabel}: ${formatValue(y)}${unit}`;
      },
      // 덧붙임: 가까운 사건 기록 + 실험별 추가 정보(extra)
      afterBody(items) {
        const lines = [];
        const item = items[0];
        const point = type === "bar"
          ? { x: item.parsed.x, y: item.parsed.y }
          : { x: item.parsed.x, y: item.parsed.y, t: item.parsed.x * 60, v: item.parsed.y };

        // 사건 기록("창문 열기" 등) 근처면 그 이름도 보여준다 (§7.1)
        if (type !== "bar" && events?.length) {
          const scale = item.chart.scales.x;
          // "근처" 기준: 보이는 범위의 2% (최소 15초)
          const near = Math.max(15, (scale.max - scale.min) * 60 * 0.02);
          for (const ev of events) {
            if (Math.abs(ev.t - point.t) <= near) lines.push(`📌 ${ev.label} (${formatTime(ev.t, opt.timeFormat)})`);
          }
        }
        if (typeof opt.extra === "function") {
          const extraLine = opt.extra(point);
          if (extraLine) lines.push(extraLine);
        }
        return lines;
      },
    },
  };
}

// ── 기준선·사건 기록선 플러그인 ─────────────────────────
// 기준선(수평)과 사건 기록(수직)을 그린다.
// 외부 annotation 라이브러리를 쓰지 않기 위해 직접 그린다.
const markerPlugin = {
  id: "sdsMarkers",
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: area, scales } = chart;
    if (!area) return;
    ctx.save();

    // 수평 기준선 (예: 1,000ppm)
    const ref = opts?.refLine;
    if (ref && Number.isFinite(ref.value)) {
      const y = scales.y.getPixelForValue(ref.value);
      if (y >= area.top && y <= area.bottom) {
        const color = ref.color || "#dc2626";
        ctx.strokeStyle = color;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(area.left, y);
        ctx.lineTo(area.right, y);
        ctx.stroke();
        if (ref.label) {
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.font = "12px sans-serif";
          ctx.textAlign = "right";
          ctx.fillText(ref.label, area.right - 4, y - 5);
        }
      }
    }

    // 수직 사건 기록선 (예: "창문 열기") — t(초)를 분으로 바꿔 위치를 잡는다
    (opts?.events || []).forEach((ev, i) => {
      const x = scales.x.getPixelForValue(ev.t / 60);
      if (x < area.left || x > area.right) return;
      ctx.strokeStyle = "#6b7280";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      if (ev.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = "#374151";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        // 라벨이 겹치지 않게 번갈아 높이를 바꾼다
        ctx.fillText(ev.label, x + 4, area.top + 14 + (i % 2) * 16);
      }
    });

    ctx.restore();
  },
};
