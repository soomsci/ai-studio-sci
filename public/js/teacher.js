// js/teacher.js — 선생님 대시보드 앱 셸 (세션 E)
//
// 구성 (SPEC §11 세션 E):
//   - Google 로그인, 학급 선택, 학급 만들기(v2.1), 탭 전환
//   - 탭 4개(모둠별 진행 현황·학급 종합 그래프·데이터 관리·교실 화면)의 실제 내용은
//     js/teacher-tabs.js가 그린다. 데이터 조회는 js/teacher-data.js. 두 파일 상단 주석 참고.

import { isConfigured, getFirebase } from "./firebase-init.js";
import { fetchMyClasses, createClass } from "./teacher-data.js";
import { renderProgressTab, renderChartTab, renderManageTab, renderTvTab } from "./teacher-tabs.js";

let currentUser = null;
let myClasses = [];
let currentClass = null; // { id, name, activeExp, ... }

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

  setupNewClassModal();
  await refreshClassList();
}

// 학급 목록을 다시 불러와 드롭다운을 채운다. selectId를 주면 그 학급을 골라 보여준다.
async function refreshClassList(selectId) {
  myClasses = await fetchMyClasses(currentUser.uid);
  const select = document.getElementById("class-select");
  select.innerHTML = "";
  if (myClasses.length === 0) {
    select.innerHTML = `<option>담당 학급이 없어요</option>`;
    openNewClassModal(); // 만들 학급이 없으면 바로 만들기 화면을 띄운다
    return;
  }
  myClasses.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name || c.id;
    select.append(opt);
  });
  select.onchange = () => selectClass(select.value);

  await selectClass(selectId || myClasses[0].id);
}

// ── 학급 만들기 (v2.1) ───────────────────────────────────

function setupNewClassModal() {
  document.getElementById("new-class-btn").addEventListener("click", () => openNewClassModal());
  document.getElementById("new-class-cancel").addEventListener("click", () => closeNewClassModal());
  document.getElementById("new-class-submit").addEventListener("click", handleCreateClass);
}

function openNewClassModal() {
  document.getElementById("new-class-error").style.display = "none";
  document.getElementById("new-class-name").value = "";
  document.getElementById("new-class-code").value = "";
  document.getElementById("new-class-modal").style.display = "flex";
}

function closeNewClassModal() {
  document.getElementById("new-class-modal").style.display = "none";
}

async function handleCreateClass() {
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
  submitBtn.textContent = "만드는 중…";
  try {
    const newClass = await createClass({ name, joinCode, teacherUid: currentUser.uid });
    closeNewClassModal();
    await refreshClassList(newClass.id);
  } catch (err) {
    errBox.textContent = err.message || "학급을 만들지 못했어요. 다시 시도해 주세요.";
    errBox.style.display = "block";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "만들기";
  }
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
