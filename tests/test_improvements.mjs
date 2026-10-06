import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const urlFor = (source) => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const moduleUrls = new Map();
async function moduleUrl(path) {
  if (moduleUrls.has(path)) return moduleUrls.get(path);
  let source = await readFile(new URL("../" + path, import.meta.url), "utf8");
  for (const match of [...source.matchAll(/from "(\.\.?\/[^\"]+)"/g)]) {
    const target = new URL(match[1], "https://test/" + path).pathname.slice(1);
    source = source.replace(match[0], `from "${await moduleUrl(target)}"`);
  }
  const url = urlFor(source);
  moduleUrls.set(path, url);
  return url;
}

// 화면 검사에 필요한 DOM 동작만 제공한다. 브라우저 레이아웃은 검사하지 않는다.
class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.classList = { add() {}, toggle() {} };
    this.style = {};
    this.value = "";
    this._html = "";
    this._text = "";
  }
  get isConnected() { return this.root || Boolean(this.parent?.isConnected); }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) {
    for (const item of this.children) item.parent = null;
    this.children = [];
    this.append(...items);
  }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  set innerHTML(html) {
    this.replaceChildren();
    this._html = html;
    if (html.includes("<tbody>")) this.append(new Element("tbody"));
    for (const id of ["chart-exp-select", "chart-sensor-select"]) {
      if (!html.includes(`id="${id}"`)) continue;
      const select = new Element("select");
      select.id = id;
      if (id === "chart-exp-select") {
        select.value = "1";
        select.optionsHtml = html;
      }
      this.append(select);
    }
  }
  get innerHTML() { return this._html; }
  set textContent(text) { this.replaceChildren(); this._text = String(text); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelector(selector) {
    if (selector === "button" && this._html.includes("<button") && !this.children.some((c) => c.tag === "button")) {
      this.append(new Element("button"));
    }
    return this.children.flatMap(function visit(child) { return [child, ...child.children.flatMap(visit)]; })
      .find((child) => selector.startsWith("#") ? child.id === selector.slice(1) : child.tag === selector) || null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(function visit(child) { return [child, ...child.children.flatMap(visit)]; })
      .filter((child) => child.tag === selector);
  }
}
const elements = new Map();
const body = new Element("body");
body.root = true;
globalThis.document = {
  body,
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => { const node = new Element("#text"); node.textContent = text; return node; },
  getElementById(id) {
    if (!elements.has(id)) { const el = new Element(); el.root = true; elements.set(id, el); }
    return elements.get(id);
  },
};
const events = {};
globalThis.window = { addEventListener: (name, callback) => { events[name] = callback; } };

const save = await import(await moduleUrl("public/js/save-state.js"));
let fail = true;
const writes = [];
const originalError = console.error;
console.error = () => {};
const writer = async (value) => { if (fail) throw Error("통신 실패"); writes.push(value); };
await save.scheduleSave("retry", { answer: "남길 답변" }, writer, 1000);
assert.equal(save.hasUnsavedChanges(), true);
let warned = false;
events.beforeunload({ preventDefault() { warned = true; } });
assert.equal(warned, true);
assert.equal(await save.flushSaves(), false);
assert.match(body.textContent, /저장하지 못/);
fail = false;
assert.equal(await save.flushSaves(), true);
assert.deepEqual(writes, [{ answer: "남길 답변" }]);
assert.equal(save.hasUnsavedChanges(), false);
console.error = originalError;

let release;
const ordered = [];
const slowWriter = async (value) => {
  ordered.push(value.answer);
  if (ordered.length === 1) await new Promise((resolve) => { release = resolve; });
};
const first = save.scheduleSave("ordered", { answer: "이전" }, slowWriter);
await Promise.resolve();
await save.scheduleSave("ordered", { answer: "최신" }, slowWriter, 1000);
release();
await first;
assert.deepEqual(ordered, ["이전", "최신"]);
assert.equal(save.hasUnsavedChanges(), false);

// 실제 data.js 경로도 같은 저장 대기열을 사용하고 예약 당시 학급을 유지한다.
let sessionClass = "class-a";
let rejectWrite = false;
const storedAnalyses = new Map();
globalThis.dataTest = {
  session: () => ({ classId: sessionClass, groupId: "g1" }),
  firebase: () => ({ db: {}, fsMod: {
    doc: (_db, ...path) => path.join("/"),
    async setDoc(path, value) {
      if (rejectWrite) throw Error("저장 거부");
      storedAnalyses.set(path, value);
    },
    async getDoc(path) {
      return { exists: () => storedAnalyses.has(path), data: () => storedAnalyses.get(path) };
    },
  } }),
};
moduleUrls.set("public/js/firebase-init.js", urlFor('export const isConfigured = true; export const getFirebase = async () => globalThis.dataTest.firebase();'));
moduleUrls.set("public/js/auth.js", urlFor('export const getSession = () => globalThis.dataTest.session(); export const ensureAuth = async () => "uid";'));
const data = await import(await moduleUrl("public/js/data.js"));
const draft = { expNo: 1, groupId: "g1", answers: { s1: "예약한 답" } };
await data.saveAnalysis(draft, 1000);
draft.answers.s1 = "예약 후 바뀐 글";
sessionClass = "class-b";
await save.flushSaves();
assert.equal(storedAnalyses.get("classes/class-a/analyses/exp1_g1").answers.s1, "예약한 답");
rejectWrite = true;
console.error = () => {};
assert.equal(await data.saveAnalysis(draft), false);
await assert.rejects(data.getAnalysis(1, "g1"), /다시 저장/);
rejectWrite = false;
await save.flushSaves();
assert.equal((await data.getAnalysis(1, "g1")).answers.s1, "예약 후 바뀐 글");
console.error = originalError;

const { escapeText, fitSlope, renderDatasetChoices } = await import(await moduleUrl("public/js/utils.js"));
assert.equal(escapeText(`<img src=x onerror="alert('x')">&`), "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;");
assert.equal(fitSlope([]), 0);
assert.equal(fitSlope([{ t: 1, v: 1 }, { t: 1, v: 2 }]), 0);
assert.equal(fitSlope([{ t: 0, v: 1 }, { t: 10, v: 21 }]), 2);
const attack = `<img src=x onerror="alert('x')">`;
const choices = new Element();
const selection = { datasetIds: [] };
let selected = 0;
renderDatasetChoices(choices, { datasets: [{ id: attack, title: attack, condition: attack, points: [] }],
  analysis: selection, prefix: "exp1", onChange: () => { selected++; } });
assert.equal(choices.children[0].children[1].textContent, attack);
assert.equal(choices.children[0].innerHTML, "");
const checkbox = choices.children[0].children[0];
checkbox.checked = true;
checkbox.listeners.change();
checkbox.listeners.change();
assert.deepEqual(selection.datasetIds, [attack]);
assert.equal(selected, 2);

const chartInstances = [];
globalThis.Chart = class {
  constructor(canvas, config) { this.canvas = canvas; this.config = config; this.destroyed = false; chartInstances.push(this); }
  destroy() { this.destroyed = true; }
};
const charts = await import(await moduleUrl("public/js/chart-kit.js"));
const canvas = new Element("canvas");
body.append(canvas);
const chart = charts.renderChart(canvas, { type: "line" });
canvas.remove();
charts.cleanupCharts();
assert.equal(chart.destroyed, true);
body.append(canvas);
charts.restoreCharts(body);
assert.equal(chartInstances.at(-1).canvas, canvas);
assert.equal(chartInstances.at(-1).destroyed, false);
canvas.remove();
charts.cleanupCharts();

let failLookup = true;
let lookups = 0;
let analysisDocs = {};
let measured = [];
globalThis.teacherTest = {
  async datasets() { lookups++; if (failLookup) { failLookup = false; throw Error("일시 실패"); } return measured; },
  async analyses() { return analysisDocs; },
};
moduleUrls.set("public/js/data.js", urlFor('export const MODE = "firebase";'));
moduleUrls.set("public/js/teacher-data.js", urlFor(`
export const fetchClassDatasets = (...args) => globalThis.teacherTest.datasets(...args);
export const fetchAllAnalyses = () => globalThis.teacherTest.analyses();
export const fetchAnalysis = () => ({});
export const deleteDatasetDoc = () => {};
export const setActiveExpField = () => {};
export const setVisibleExpsField = () => {};
export const getVisibleExps = (cls) => Array.isArray(cls.visibleExps) ? cls.visibleExps : [1,2,3];
`));
const teacher = await import(await moduleUrl("public/js/teacher-tabs.js"));
const { EXP1 } = await import(await moduleUrl("public/config/exp1.config.js"));
const { EXP3 } = await import(await moduleUrl("public/config/exp3.config.js"));
const analysis = { answers: { d1: "계획", d2: "계획", d3: "계획", gx: "시간", gy: "농도" } };
assert.equal(teacher.analysisProgress(1, analysis).answered, 0);
for (const step of EXP1.steps.filter((step) => step.type !== "choice")) {
  if (step.field) analysis[step.field] = "결론";
  else analysis.answers[step.id] = "분석";
}
assert.equal(teacher.analysisProgress(1, analysis).answered, 5);
assert.equal(teacher.analysisProgress(1, analysis).total, 5);
for (const topic of ["intensity_hr", "recovery"]) {
  const a = { answers: {}, chartOptions: { topic } };
  for (const step of EXP3[topic].steps) {
    if (step.type === "choice") continue;
    if (step.field) a[step.field] = "결론";
    else a.answers[step.id] = "분석";
  }
  assert.equal(teacher.analysisProgress(3, a).answered, 5);
}
await assert.rejects(teacher.renderProgressTab({ id: "class" }), /일시 실패/);
analysisDocs = { exp1_g7: { expNo: 1, groupId: "g7", answers: { d1: "계획만" } } };
await teacher.renderProgressTab({ id: "class" });
assert.ok(lookups > 4);
const table = elements.get("tab-progress").querySelector("tbody");
assert.match(table.children[0].innerHTML, /7모둠/);
assert.match(table.children[0].innerHTML, /0\/5/);

measured = [
  { expNo: 4, groupId: "g1", sensor: "CO2", unit: "ppm", startedAt: new Date(2), points: [{ t: 0, v: 900 }] },
  { expNo: 4, groupId: "g1", sensor: "Temperature", unit: "℃", startedAt: new Date(1), points: [{ t: 0, v: 20 }] },
  { expNo: 4, groupId: "g2", sensor: "CO2", unit: "ppm", startedAt: new Date(3), points: [{ t: 0, v: 800 }] },
];
teacher.invalidateDatasetsCache();
await teacher.renderChartTab({ id: "class" });
const chartTab = elements.get("tab-chart");
const expSelect = chartTab.querySelector("#chart-exp-select");
assert.match(expSelect.optionsHtml, /value="4"/);
const sensorSelect = chartTab.querySelector("#chart-sensor-select");
sensorSelect.value = JSON.stringify(["Temperature", "℃"]);
sensorSelect.listeners.change();
const latestChart = chartInstances.at(-1).config;
assert.equal(latestChart.data.datasets.length, 1);
assert.equal(latestChart.data.datasets[0].data[0].y, 20);
assert.match(latestChart.options.scales.y.title.text, /온도/);

measured = [{ expNo: 1, groupId: attack, title: attack, startedAt: new Date(), points: [] }];
teacher.invalidateDatasetsCache();
await teacher.renderManageTab({ id: "class" });
const managedRows = elements.get("tab-manage").querySelector("tbody").children;
assert.ok(managedRows.every((row) => row.innerHTML.includes("&lt;img")));
assert.ok(managedRows.every((row) => !row.innerHTML.includes("<img")));

const collectorSource = await readFile(new URL("../collector/static/measure.js", import.meta.url), "utf8");
runInNewContext(collectorSource + '\nrenderChannels(testChannels, "stopped");', {
  document, updateChannelsChart() {},
  testChannels: [{ deviceId: attack, label: attack, title: attack, count: 1, latestValue: 20, unit: attack }],
});
assert.ok(elements.get("channelList").textContent.includes(attack));
assert.equal(elements.get("channelList").children[0].innerHTML, "");

// 비동기 학급 전환: 이전 학급의 늦은 조회가 최신 화면을 덮지 않는다.
let releaseOld;
globalThis.teacherTest.analyses = async () => ({});
globalThis.teacherTest.datasets = async (classId) => {
  if (classId === "old") return new Promise((resolve) => { releaseOld = resolve; });
  return [];
};
const oldRender = teacher.renderChartTab({ id: "old" });
await teacher.renderChartTab({ id: "new" });
const newToolbar = elements.get("tab-chart").children[0];
releaseOld(measured);
await oldRender;
assert.equal(elements.get("tab-chart").children[0], newToolbar);

// 모두 숨긴 경우와 필드가 없는 경우를 구분하는 실제 학생 시동 조건.
const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const visibilityCode = index.match(/let visibleExps = \[1, 2, 3\];/)[0] + "\n" +
  index.match(/if \(classInfo && Array\.isArray\(classInfo\.visibleExps\)[\s\S]*?\n        \}/)[0] + "\nreturn visibleExps;";
const visible = new Function("classInfo", visibilityCode);
assert.deepEqual(visible({}), [1, 2, 3]);
assert.deepEqual(visible({ visibleExps: [] }), []);
assert.deepEqual(visible({ visibleExps: [4] }), [4]);

console.log("저장·재시도·이탈, 표시, 계산, 차트 정리, 교사 캐시·진도·그래프·학급 전환, 실험 숨김 검사 통과");
