// js/raw-data.js — 원본 측정값 표 + CSV 내려받기 (세션 A 공통)
//
// 실험 탭(B·C·D)이 "데이터 살펴보기"(1단계)에서 호출한다.
// ★ 읽기 전용이다 — datasets를 절대 고치지 않는다 (원본 보호, 절대 규칙 6).
//
// renderRawDataTable(el, datasets, csvFileName?)
//   el          : 표를 그려 넣을 컨테이너 요소 (안의 내용은 지워지고 새로 그려진다)
//   datasets    : listDatasets()가 준 측정 배열. 각 측정은
//                 { title, unit, points: [{ t, v }], ... } 형태 (SPEC §5.1)
//   csvFileName : (선택) 주면 표 위에 "CSV로 내려받기" 단추가 생긴다.
//                 예: "측정데이터_실험1"  (".csv"는 알아서 붙는다)
//   → 측정마다 시각(분:초)·경과 초·값(단위) 표를 그린다.
//     점이 많으면(수백 개) 스크롤 영역에 담아 화면을 해치지 않는다.
//     측정을 여러 개 골랐으면 측정별로 구분해서 보여준다.
//
// downloadDatasetsCSV(datasets, csvFileName)
//   고른 측정들의 원본 값을 CSV 파일로 바로 내려받는다.
//   엑셀에서 바로 열리고 한글이 깨지지 않는다(UTF-8 BOM).
//   열: 측정 제목 · 경과 초(t) · 시각(분:초) · 값 · 단위.
//   측정이 여러 개면 한 파일에 이어 담되 "측정 제목" 열로 구분된다.
//   단추 없이 직접 불러 써도 된다.

// 경과 초 → 사람이 읽는 "3분 20초" (chart-kit 말풍선과 같은 형식)
function formatTime(sec) {
  sec = Math.round(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}분 ${String(s).padStart(2, "0")}초`;
}

// ── 표 그리기 ───────────────────────────────────────────
export function renderRawDataTable(el, datasets, csvFileName) {
  injectStyleOnce();
  el.innerHTML = "";
  el.classList.add("raw-data");

  const list = (datasets || []).filter((d) => d && Array.isArray(d.points));
  if (!list.length) {
    el.append(elem("p", "raw-empty", "아직 고른 측정이 없어요. 측정을 고르면 여기에 값이 표로 나와요."));
    return;
  }

  // CSV 내려받기 단추 (파일 이름을 넘겨줬을 때만)
  if (csvFileName) {
    const btn = elem("button", "raw-dl-btn", "📄 이 값을 CSV 파일로 내려받기");
    btn.type = "button";
    btn.addEventListener("click", () => downloadDatasetsCSV(list, csvFileName));
    el.append(btn);
  }

  // 측정마다 제목 + 점 개수 + 스크롤 표
  list.forEach((d) => {
    const box = elem("div", "raw-ds");
    box.append(elem("h4", "raw-ds-title",
      `${d.title || "이름 없는 측정"}  ·  ${d.points.length}개 값  ·  단위 ${d.unit || "-"}`));

    const scroll = elem("div", "raw-scroll");
    const table = elem("table", "raw-table");
    table.innerHTML =
      "<thead><tr><th>시각</th><th>경과 시간(초)</th><th>값</th></tr></thead>";
    const tbody = elem("tbody");
    d.points.forEach((p) => {
      const tr = elem("tr");
      tr.append(elem("td", null, formatTime(p.t)));
      tr.append(elem("td", "raw-num", String(p.t)));
      tr.append(elem("td", "raw-num", `${p.v} ${d.unit || ""}`.trim()));
      tbody.append(tr);
    });
    table.append(tbody);
    scroll.append(table);
    box.append(scroll);
    el.append(box);
  });
}

// ── CSV 만들기·내려받기 ─────────────────────────────────
export function downloadDatasetsCSV(datasets, csvFileName) {
  const list = (datasets || []).filter((d) => d && Array.isArray(d.points));
  const csv = buildCSV(list);

  // UTF-8 BOM을 앞에 붙여야 엑셀에서 한글이 깨지지 않는다
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = /\.csv$/i.test(csvFileName) ? csvFileName : `${csvFileName || "측정데이터"}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildCSV(list) {
  const rows = [["측정 제목", "경과 초", "시각", "값", "단위"]];
  list.forEach((d) => {
    d.points.forEach((p) => {
      rows.push([d.title || "", p.t, formatTime(p.t), p.v, d.unit || ""]);
    });
  });
  // 엑셀 호환을 위해 줄바꿈은 CRLF
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

// 콤마·따옴표·줄바꿈이 들어간 칸은 큰따옴표로 감싼다 (측정 제목에 콤마가 있을 수 있음)
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── 도우미 ──────────────────────────────────────────────
function elem(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// 이 모듈이 쓰는 스타일을 <head>에 한 번만 넣는다 (style.css를 건드리지 않기 위해).
function injectStyleOnce() {
  if (document.getElementById("raw-data-style")) return;
  const s = document.createElement("style");
  s.id = "raw-data-style";
  s.textContent = `
    .raw-data .raw-dl-btn { background:#2563eb; color:#fff; border:none; border-radius:8px;
      padding:8px 16px; font-size:15px; cursor:pointer; margin-bottom:12px; }
    .raw-data .raw-dl-btn:hover { background:#1e40af; }
    .raw-data .raw-empty { color:#6b7280; }
    .raw-data .raw-ds { margin-bottom:18px; }
    .raw-data .raw-ds-title { margin:0 0 6px; font-size:15px; }
    .raw-data .raw-scroll { max-height:280px; overflow:auto; border:1px solid #e5e7eb; border-radius:8px; }
    .raw-data table.raw-table { width:100%; border-collapse:collapse; font-size:14px; }
    .raw-data .raw-table th, .raw-data .raw-table td { padding:5px 12px; border-bottom:1px solid #f0f0f0; text-align:left; }
    .raw-data .raw-table thead th { position:sticky; top:0; background:#f5f7fb; font-weight:700; }
    .raw-data .raw-table td.raw-num { text-align:right; font-variant-numeric:tabular-nums; }
  `;
  document.head.append(s);
}
