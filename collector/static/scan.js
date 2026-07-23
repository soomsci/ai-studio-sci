// static/scan.js — 주변 센서 검색·선택 (세션 F)
//
// 같은 교실에서 여러 모둠이 동시에 센서를 켜면 검색 결과에 여러 대가 함께
// 잡힌다. 그래서 번호(deviceId)를 목록에 크게 보여줘서, 학생이 자기 모둠
// 센서 몸통에 적힌 번호와 맞춰 골라야 한다 — 첫 번째를 그냥 고르면 옆 모둠
// 센서에 붙어 남의 데이터를 기록하게 된다(세션 G가 실물 센서로 확인).

document.getElementById("btnScan").addEventListener("click", async () => {
  const msg = document.getElementById("scan-msg");
  const list = document.getElementById("scanList");
  msg.textContent = "";
  list.innerHTML = "<li>찾는 중이에요...</li>";
  const sensorType = document.getElementById("channelSensorType").value;
  const res = await fetch(`/api/scan?type=${encodeURIComponent(sensorType)}`);
  const result = await res.json();
  if (!result.ok) {
    list.innerHTML = "";
    msg.textContent = result.error;
    return;
  }
  if (result.devices.length === 0) {
    list.innerHTML = "";
    msg.textContent = "센서를 못 찾았어요. 전원이 켜져 있는지, 다른 노트북이 이미 연결하고 있진 않은지 확인해 보세요.";
    return;
  }
  renderScanResults(result.devices);
});

function renderScanResults(devices) {
  const list = document.getElementById("scanList");
  list.innerHTML = "";
  devices.forEach((d) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="num">${d.deviceId}</span>${d.sensorType}`;
    li.addEventListener("click", () => {
      list.querySelectorAll("li").forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");
      document.getElementById("channelDeviceId").value = d.deviceId;
      if (typeof autoFillTitle === "function") autoFillTitle();
    });
    list.appendChild(li);
  });
}
