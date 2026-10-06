// HTML 틀에 넣는 글자는 태그나 속성으로 해석되지 않게 한다.
export function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 최소제곱법 기울기(값/초). 같은 시각만 있거나 점이 부족하면 0.
export function fitSlope(points) {
  if (points.length < 2) return 0;
  const mt = points.reduce((sum, p) => sum + p.t, 0) / points.length;
  const mv = points.reduce((sum, p) => sum + p.v, 0) / points.length;
  let numerator = 0, denominator = 0;
  for (const p of points) {
    numerator += (p.t - mt) * (p.v - mv);
    denominator += (p.t - mt) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

// 실험 1~4가 같은 측정 선택 목록을 사용한다. 입력값은 DOM의 글자로 넣는다.
export function renderDatasetChoices(listEl, { datasets, analysis, prefix, onChange }) {
  listEl.replaceChildren();
  if (!datasets.length) {
    const message = document.createElement("p");
    message.className = prefix + "-dim";
    message.textContent = "아직 측정이 없어요. 아래에서 연습 데이터를 만들어 보세요.";
    listEl.append(message);
    return;
  }
  for (const d of datasets) {
    const label = document.createElement("label");
    label.className = prefix + "-item";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = analysis.datasetIds.includes(d.id);
    box.addEventListener("change", () => {
      analysis.datasetIds = box.checked
        ? [...new Set([...analysis.datasetIds, d.id])]
        : analysis.datasetIds.filter((id) => id !== d.id);
      onChange();
    });
    const title = document.createElement("b");
    title.textContent = d.title || "(제목 없음)";
    const details = document.createElement("span");
    details.className = prefix + "-dim";
    const points = d.points || [];
    details.textContent = ` ${d.condition} · ${Math.round((points.at(-1)?.t || 0) / 60)}분 · ${points.length}개 점${d.source === "mock" ? " · 연습" : ""}`;
    label.append(box, title, details);
    listEl.append(label);
  }
}
