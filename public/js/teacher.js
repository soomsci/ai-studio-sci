// js/teacher.js — 선생님 대시보드 앱 셸 (세션 E)
//
// 구성 (SPEC §11 세션 E):
//   - Google 로그인, 학급 선택, 학급 관리(만들기·수정·삭제 — v2.1, v2.3), 탭 전환
//   - 탭 4개(모둠별 진행 현황·학급 종합 그래프·데이터 관리·교실 화면)의 실제 내용은
//     js/teacher-tabs.js가 그린다. 데이터 조회는 js/teacher-data.js. 두 파일 상단 주석 참고.

import { isConfigured, getFirebase } from "./firebase-init.js";
import { fetchMyClasses, createClass, updateClass, deleteClass, countClassContents } from "./teacher-data.js";
import { renderProgressTab, renderChartTab, renderManageTab, renderTvTab } from "./teacher-tabs.js";

let currentUser = null;
let myClasses = [];
let currentClass = null; // { id, name, joinCode, activeExp, ... }
let editingClass = null; // 학급 만들기·수정 모달이 지금 어느 모드인지 (null이면 만들기)

// ── 시작 ────────────────────────────────────────────────

if (!isConfigured) {
  // 연습 모드: 실제 로그인 없이 바로 대시보드로 들어간다 (다른 화면들의 연습 모드 관행과 동일)
  currentUser = { uid: "mock-teacher", email: "연습 모드" };
  enterDashboard();
} else {
  document.getElementById("google-login-btn").addEventListener("click", handleLogin);
  watchAuthState();
}

async function handleLogin() {
  const errBox = document.getElementById("login-error");
  errBox.style.display = "none";
  try {
    const { auth, authMod } = await getFirebase();
    const provider = new authMod.GoogleAuthProvider();
    const cred = await authMod.signInWithPopup(auth, provider);
    currentUser = cred.user;
  } catch (err) {
    console.error(err);
    errBox.textContent = "로그인에 실패했어요. 다시 시도해 주세요.";
    errBox.style.display = "block";
  }
}

function watchAuthState() {
  getFirebase().then(({ auth, authMod }) => {
    authMod.onAuthStateChanged(auth, (user) => {
      if (user) { currentUser = user; enterDashboard(); }
    });
  });
}

async function enterDashboard() {
  document.getElementById("login-gate").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  document.getElementById("teacher-label").textContent = currentUser.email || "";

  document.getElementById("logout-btn").addEventListener("click", async () => {
    if (isConfigured) {
      const { auth, authMod } = await getFirebase();
      await authMod.signOut(auth);
    }
    location.reload();
  });

  // 탭 전환
  document.querySelectorAll(".th-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  setupClassModal();
  document.getElementById("edit-class-btn").addEventListener("click", () => {
    if (currentClass) openClassModal(currentClass);
  });
  document.getElementById("delete-class-btn").addEventListener("click", handleDeleteClass);

  await refreshClassList();
}

// 드롭다운만 다시 채운다 (선택은 건드리지 않는다)
function populateClassSelect() {
  const select = document.getElementById("class-select");
  select.innerHTML = "";
  if (myClasses.length === 0) {
    select.innerHTML = `<option>담당 학급이 없어요</option>`;
    return;
  }
  myClasses.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name || c.id;
    select.append(opt);
  });
  select.onchange = () => selectClass(select.value);
}

// 학급 목록을 다시 불러와 드롭다운을 채우고, selectId를 주면 그 학급을 골라 보여준다.
async function refreshClassList(selectId) {
  myClasses = await fetchMyClasses(currentUser.uid);
  populateClassSelect();
  if (myClasses.length === 0) {
    currentClass = null;
    openClassModal(); // 만들 학급이 없으면 바로 만들기 화면을 띄운다
    return;
  }
  await selectClass(selectId || myClasses[0].id);
}

// ── 학급 관리 — 만들기·수정 모달 (v2.1, v2.3) ─────────────

function setupClassModal() {
  document.getElementById("new-class-btn").addEventListener("click", () => openClassModal());
  document.getElementById("new-class-cancel").addEventListener("click", () => closeClassModal());
  document.getElementById("new-class-submit").addEventListener("click", handleClassSubmit);
}

// cls를 주면 수정 모드(입력칸을 채우고 저장 시 updateClass), 안 주면 만들기 모드.
function openClassModal(cls) {
  editingClass = cls || null;
  document.getElementById("new-class-title").textContent = cls ? "학급 정보 수정" : "새 학급 만들기";
  document.getElementById("new-class-submit").textContent = cls ? "저장" : "만들기";
  document.getElementById("new-class-code-hint").style.display = cls ? "block" : "none";
  document.getElementById("new-class-error").style.display = "none";
  document.getElementById("new-class-name").value = cls?.name || "";
  document.getElementById("new-class-code").value = cls?.joinCode || "";
  document.getElementById("new-class-modal").style.display = "flex";
}

function closeClassModal() {
  document.getElementById("new-class-modal").style.display = "none";
  editingClass = null;
}

async function handleClassSubmit() {
  const errBox = document.getElementById("new-class-error");
  const submitBtn = document.getElementById("new-class-submit");
  const name = document.getElementById("new-class-name").value.trim();
  const joinCode = document.getElementById("new-class-code").value.trim();
  errBox.style.display = "none";

  if (!name || !joinCode) {
    errBox.textContent = "반 이름과 입장 코드를 모두 입력해 주세요.";
    errBox.style.display = "block";
    return;
  }

  submitBtn.disabled = true;
  try {
    if (editingClass) {
      submitBtn.textContent = "저장하는 중…";
      await updateClass(editingClass.id, { name, joinCode, oldJoinCode: editingClass.joinCode });
      // editingClass는 myClasses(그리고 그게 지금 선택된 학급이면 currentClass)와 같은 객체 참조라
      // 여기서 값을 바꾸면 화면 쪽에도 그대로 반영된다.
      editingClass.name = name;
      editingClass.joinCode = joinCode;
      closeClassModal();
      populateClassSelect();
      document.getElementById("class-select").value = editingClass.id;
    } else {
      submitBtn.textContent = "만드는 중…";
      const newClass = await createClass({ name, joinCode, teacherUid: currentUser.uid });
      closeClassModal();
      await refreshClassList(newClass.id);
    }
  } catch (err) {
    errBox.textContent = err.message || "저장하지 못했어요. 다시 시도해 주세요.";
    errBox.style.display = "block";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = editingClass ? "저장" : "만들기";
  }
}

// ── 학급 삭제 (v2.3) — 되돌릴 수 없어서 안의 데이터 개수를 세어 경고한다 ──

async function handleDeleteClass() {
  if (!currentClass?.id) return;

  const { datasets, analyses } = await countClassContents(currentClass.id);
  const warn = (datasets || analyses)
    ? `이 학급의 측정 ${datasets}건, 분석 ${analyses}건도 함께 지워집니다. 되돌릴 수 없어요. 정말 지울까요?`
    : `"${currentClass.name || currentClass.id}" 학급을 지울까요? 되돌릴 수 없어요.`;
  if (!confirm(warn)) return;

  try {
    await deleteClass(currentClass.id, { joinCode: currentClass.joinCode });
  } catch (err) {
    alert(err.message || "학급을 지우는 데 실패했어요. 다시 시도해 주세요.");
    return;
  }

  // 지금 보던 학급이 사라졌으니 목록만 새로고침하고 선택은 비운다
  myClasses = await fetchMyClasses(currentUser.uid);
  currentClass = null;
  populateClassSelect();
  if (myClasses.length > 0) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "학급을 선택하세요";
    document.getElementById("class-select").prepend(placeholder);
    document.getElementById("class-select").value = "";
  }
  ["tab-progress", "tab-chart", "tab-manage", "tab-tv"].forEach((id) => {
    document.getElementById(id).innerHTML = `<p style="color:var(--dim)">학급을 선택해 주세요.</p>`;
  });
  if (myClasses.length === 0) openClassModal();
}

async function selectClass(classId) {
  currentClass = myClasses.find((c) => c.id === classId) || { id: classId };
  await renderProgressTab(currentClass);
  await renderChartTab(currentClass);
  await renderManageTab(currentClass);
  await renderTvTab(currentClass);
}

function switchTab(name) {
  document.querySelectorAll(".th-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".th-section").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
}
