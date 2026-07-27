import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

let source = await readFile(new URL("../public/js/teacher-data.js", import.meta.url), "utf8");
source = source
  .replace('import { getFirebase } from "./firebase-init.js";', "")
  .replace(
    'import { MODE, listClassDatasets, getAnalysis } from "./data.js";',
    'const MODE = "firebase"; const listClassDatasets = () => {}; const getAnalysis = () => {};'
  )
  .replace(
    /async function fsCtx\(\) \{[\s\S]*?\n\}/,
    "let testCtx;\nasync function fsCtx() { return testCtx; }"
  )
  + "\nexport function setTestCtx(value) { testCtx = value; }\n";

const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { createClass, updateClass, deleteClass, setTestCtx } = await import(moduleUrl);

function makeFirestore() {
  const classes = new Map();
  const codes = new Map();
  let failDeleteCodeOnce = "";

  const ref = (...parts) => ({ path: parts.filter((part) => typeof part === "string").join("/") });
  const f = {
    collection: (...parts) => ref(...parts),
    doc: (...parts) => ref(...parts),
    where: () => ({}),
    query: (...parts) => ({ path: parts[0].path }),
    async getDocs(target) {
      if (target.path === "classes") {
        return {
          docs: [...classes.entries()].map(([id, data]) => ({
            id, data: () => ({ ...data }),
          })),
        };
      }
      return { docs: [] };
    },
    async getDoc(target) {
      const parts = target.path.split("/");
      const data = parts[0] === "classes" ? classes.get(parts[1]) : codes.get(parts[1]);
      return { exists: () => Boolean(data), data: () => ({ ...data }) };
    },
    async addDoc(_target, data) {
      classes.set("new-class", { ...data });
      return { id: "new-class" };
    },
    async updateDoc(target, data) {
      const id = target.path.split("/")[1];
      classes.set(id, { ...classes.get(id), ...data });
    },
    async setDoc(target, data) {
      codes.set(target.path.split("/")[1], { ...data });
    },
    async deleteDoc(target) {
      const [kind, id] = target.path.split("/");
      if (kind === "joinCodes" && id === failDeleteCodeOnce) {
        failDeleteCodeOnce = "";
        throw new Error("temporary delete failure");
      }
      (kind === "classes" ? classes : codes).delete(id);
    },
    writeBatch() {
      const deletes = [];
      return {
        delete(target) { deletes.push(target); },
        async commit() {
          for (const target of deletes) {
            const [kind, id] = target.path.split("/");
            (kind === "classes" ? classes : codes).delete(id);
          }
        },
      };
    },
  };

  return {
    f, classes, codes,
    failNextCodeDelete(code) { failDeleteCodeOnce = code; },
  };
}

{
  const db = {};
  const store = makeFirestore();
  store.classes.set("class-1", { name: "기존 반", joinCode: "OLD", teacherUid: "teacher-1" });
  store.codes.set("OLD", { classId: "class-1" });
  setTestCtx({ db, f: store.f });

  store.failNextCodeDelete("OLD");
  await assert.rejects(
    updateClass("class-1", { name: "기존 반", joinCode: "NEW", oldJoinCode: "OLD" }),
    /다시 저장/
  );
  assert.equal(store.classes.get("class-1").joinCode, "NEW");
  assert.equal(store.codes.get("NEW").classId, "class-1");
  assert.equal(store.codes.get("OLD").classId, "class-1");

  await updateClass("class-1", { name: "기존 반", joinCode: "NEW", oldJoinCode: "OLD" });
  assert.equal(store.codes.has("OLD"), false);
  assert.equal(store.codes.get("NEW").classId, "class-1");
}

{
  const db = {};
  const store = makeFirestore();
  store.classes.set("legacy", { name: "옛 반", joinCode: "TeSt", teacherUid: "teacher-1" });
  setTestCtx({ db, f: store.f });
  await assert.rejects(
    createClass({ name: "새 반", joinCode: "test", teacherUid: "teacher-1" }),
    /대소문자만 다른/
  );
}

{
  const db = {};
  const store = makeFirestore();
  store.classes.set("class-1", { name: "삭제할 반", joinCode: "CODE", teacherUid: "teacher-1" });
  store.codes.set("CODE", { classId: "class-1" });
  setTestCtx({ db, f: store.f });
  await deleteClass("class-1", { joinCode: "CODE" });
  assert.equal(store.classes.has("class-1"), false);
  assert.equal(store.codes.has("CODE"), false);
}

console.log("학급 코드 부분 실패 복구 3개 시나리오 통과");
