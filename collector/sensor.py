# sensor.py — 센서 연결·측정 (세션 F)
#
# 두 경로를 제공한다 (§11 세션 F):
#   - PascoSensorSource : pasco 라이브러리로 실시간 블루투스 연결 (CO2·온도·조도·전류·전압)
#   - ManualInputSource : pasco 공식 지원 목록에 없는 센서(심박수·폐활량)를 위한
#                         수동 입력 / CSV 업로드 대안 경로
#
# 두 클래스 모두 start()/record_event()/stop()을 제공해 main.py에서
# 같은 방식으로 다룰 수 있다. 반환값은 항상 §5 points/events 형태를 따른다.

from __future__ import annotations

import csv
import io
import time
import threading

# ── pasco가 실시간 연결로 공식 지원하는 센서 (부록 A: PASCO Python 라이브러리) ──
# 2026-08-18 실물 센서(CO2·조도·압력)로 확인 완료 — get_measurement_list()가
# 돌려주는 실제 문자열은 스캔용 이름(딕셔너리 키)과 다르다:
#   CO2      → "CO2Concentration" (다른 값 아님, "CO2" 아님)
#   Light    → "Illuminance"      (여러 채널 중 조도값. UVA/UVB/White/R/G/B도 있음)
#   Pressure → "Pressure"         (원래 코드에 항목 자체가 없었음)
# 키(딕셔너리 최상위 이름)는 scan()에 넘기는 BLE 기기 이름 필터라 그대로 둔다 — 실측으로
# "CO2 871-101>K8", "Light 671-389>68", "Pressure 626-370>38"에 정확히 매칭됨을 확인했다.
# Temperature·Current·Voltage는 이번에 실물이 없어 미검증 상태로 남는다.
PASCO_SENSORS = {
    "CO2": {"measurement": "CO2Concentration", "unit": "ppm"},
    "Temperature": {"measurement": "Temperature", "unit": "℃"},  # ⚠ 미검증
    "Light": {"measurement": "Illuminance", "unit": "lux"},
    "Pressure": {"measurement": "Pressure", "unit": "psi"},
    "Current": {"measurement": "Current", "unit": "A"},  # ⚠ 미검증
    "Voltage": {"measurement": "Voltage", "unit": "V"},  # ⚠ 미검증
}

# pasco 라이브러리가 BLE로 검색하는 기기 종류 목록(_compatible_devices)에 없는 센서 —
# 수동 입력/CSV 경로만 제공한다 (CLAUDE.md 전제 2).
# HeartRate: 2026-08-18 실물로 재확인 — 학교에 온 것은 PASCO 제품이 아니라 Polar H9
# (표준 블루투스 심박수 프로필 사용, PASCO 프로토콜과 무관해 pasco로는 연결 자체가
# 불가능하다). bleak로 표준 프로필 직접 연결도 시도해 서비스(0x180D)까지는 확인했지만,
# 이 모델은 손으로 계속 접촉해야 광고(advertise)가 유지되는 악력형이라 macOS
# CoreBluetooth의 GATT 연결 절차보다 접촉 유지 시간이 짧아 매번 연결 중 끊긴다.
# 실시간 연결은 이 센서로는 신뢰할 수 없다 — 수동 입력이 맞는 선택이다.
MANUAL_ONLY_SENSORS = {
    "HeartRate": "bpm",
    "VitalCapacity": "mL",
}


def available_sensors() -> dict:
    """main.py 화면에서 센서 선택 목록을 만들 때 쓴다."""
    return {
        "realtime": [{"name": k, "unit": v["unit"]} for k, v in PASCO_SENSORS.items()],
        "manual_only": [{"name": k, "unit": v} for k, v in MANUAL_ONLY_SENSORS.items()],
    }


class SensorConnectionError(RuntimeError):
    pass


_event_loop_state = threading.local()


def _ensure_event_loop() -> None:
    """pasco.pasco_ble_device를 맨 처음 import할 때 클래스 안에서 nest_asyncio.apply()가
    실행되는데, 이건 현재 스레드에 asyncio 이벤트 루프가 있어야 한다. main.py는 Flask
    요청을 메인 스레드가 아닌 별도 스레드에서 처리하므로, 루프가 없으면 여기서 바로
    "There is no current event loop in thread ..." 로 죽는다(실제 서버 실행으로 재현·확인함).
    각 채널(PASCOBLEDevice 인스턴스)이 갖는 통신용 루프(asyncio.new_event_loop())와는
    별개 문제 — 이건 import 시점 1회성 문제라서 매번 확인만 하면 된다."""
    import asyncio

    try:
        asyncio.get_running_loop()
        return
    except RuntimeError:
        pass

    loop = getattr(_event_loop_state, "loop", None)
    if loop is None or loop.is_closed():
        loop = asyncio.new_event_loop()
        _event_loop_state.loop = loop
    asyncio.set_event_loop(loop)


def _device_id_from_name(name: str | None) -> str | None:
    """pasco 기기 이름(예: "Temperature 117-880>18")에서 connect_by_id에 쓸
    번호(예: "117-880")만 뽑는다. 마지막으로 스캔된 이름 그대로 쓰면 뒤에 붙는
    ">18"(인터페이스 번호) 때문에 조용히 실패한다 — 세션 G가 실물 센서로 확인."""
    if not name:
        return None
    parts = name.split()
    if not parts:
        return None
    device_id = parts[-1].split(">")[0]
    return device_id or None


# 검색(scan)에서 잡은 BLEDevice 객체를 번호로 잠깐 기억해 둔다. connect_by_id()는
# 내부에서 스캔을 한 번 더 도는데, 방금 검색에서 이미 찾은 기기라면 그 객체로
# 바로 connect()해서 두 번째 스캔(5~10초)을 통째로 건너뛸 수 있다 — 세션 G가
# 실물 센서로 확인한 지연의 원인. 캐시가 없거나 오래돼서 비어 있으면
# connect_by_id()로 그대로 폴백한다.
_scan_cache: dict[str, object] = {}
MAX_CONSECUTIVE_READ_ERRORS = 5


def scan_sensors(sensor_name: str) -> list[dict]:
    """주변의 sensor_name 종류 센서를 모두 찾아 목록으로 돌려준다.

    같은 교실에서 여러 모둠이 동시에 센서를 켜면 이 목록에 여러 대가 함께
    잡힌다. 그래서 목록 첫 번째를 그냥 연결하면(found[0]) 다른 모둠 센서에
    붙어 남의 데이터를 기록하게 된다 — 세션 G가 실물 센서 2대로 확인한 위험.
    반드시 번호(deviceId)를 함께 돌려주고, 학생이 자기 센서 몸통의 번호와
    맞춰 골라야 한다.

    2026-08-18 실물 CO2·조도·압력 센서로 이 함수 자체(scan_sensors)를 그대로 호출해
    확인했다 — 빈 결과 시 재검색, deviceId 파싱("CO2 871-101>K8" → "871-101")까지
    실제 기기명으로 검증됨.
    """
    if sensor_name not in PASCO_SENSORS:
        raise ValueError(f"pasco로 검색할 수 없는 센서입니다: {sensor_name}")

    _ensure_event_loop()
    from pasco.pasco_ble_device import PASCOBLEDevice

    device = PASCOBLEDevice()
    try:
        found = device.scan(sensor_name)
        # 전원을 막 켠 직후 첫 검색이 비어 있는 경우가 실물 테스트에서 한 번 있었다.
        # 빈 결과일 때만 한 번 더 검색해 학생이 이유 없이 검색 버튼을 반복하지 않게 한다.
        if not found:
            found = device.scan(sensor_name)
    except device.BLEScanFailed as exc:
        raise SensorConnectionError(f"{sensor_name} 센서 검색 실패: {exc}") from exc

    results = []
    for ble_device in found:
        device_id = _device_id_from_name(getattr(ble_device, "name", None))
        if device_id:
            _scan_cache[device_id] = ble_device
            results.append({
                "deviceId": device_id,
                "label": f"{sensor_name} {device_id}",
                "sensorType": sensor_name,
            })
    return results


class PascoSensorSource:
    """pasco 라이브러리로 실시간 연결되는 센서.

    2026-08-18 실물 CO2 센서로 scan_sensors()→connect()→start()→display_points()→
    stop()→disconnect() 전체 흐름을 이 클래스 그대로 돌려 확인했다(758ppm, 1초
    간격 정상 수신, stop() 시 버킷 평균까지 정상). 조도·압력은 pasco 라이브러리
    호출부만 별도로 확인(같은 API를 그대로 감싸고 있어 결과는 동일하게 본다).
    """

    def __init__(self, sensor_name: str):
        if sensor_name not in PASCO_SENSORS:
            raise ValueError(f"pasco로 실시간 연결할 수 없는 센서입니다: {sensor_name}")
        self.sensor_name = sensor_name
        self.measurement = PASCO_SENSORS[sensor_name]["measurement"]
        self.unit = PASCO_SENSORS[sensor_name]["unit"]
        self.device_id: str | None = None
        self._device = None
        self._points: list[dict] = []  # 저장(업로드)용 — 저장 간격마다 평균 1점만 남는다
        self._bucket: list[tuple[float, float]] = []  # (경과초, 원시값) — 화면용, 다음 저장 시점까지만 쌓인다
        self._events: list[dict] = []
        self._start_time: float | None = None
        self._stop_flag = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_error: str | None = None
        self._fatal_error: str | None = None

    def connect(self, device_id: str) -> None:
        """센서 번호(예: "117-880", 센서 몸통에 인쇄된 번호)로 정확히 지정해 연결한다.
        2026-08-18 실물 CO2 센서(번호 871-101)로 확인 완료.

        스캔 결과 중 첫 번째(found[0])를 그냥 연결하는 방식은 쓰지 않는다 — 같은 스캔을
        두 번 돌리면 순서가 뒤집힐 수 있어서, 여러 센서를 동시에 쓸 때(예: 물·식용유
        온도 비교) 엉뚱한 센서에 붙어 남의 데이터를 기록할 위험이 있다.

        방금 scan_sensors()로 찾은 기기라면(_scan_cache에 있으면) 그 BLEDevice로
        바로 connect()해서 connect_by_id() 내부의 재스캔(5~10초)을 건너뛴다.
        캐시에 없으면(오래돼서 비었거나 검색 없이 번호를 직접 입력한 경우)
        connect_by_id()로 그대로 폴백한다.
        """
        if not device_id:
            raise SensorConnectionError("센서 번호를 입력해야 합니다")

        _ensure_event_loop()
        from pasco.pasco_ble_device import PASCOBLEDevice

        self._device = PASCOBLEDevice()
        # 검색 결과 객체는 한 번만 쓴다. 오래된 객체를 계속 재사용하지 않고,
        # 캐시 연결이 실패하면 번호 지정 검색으로 한 번 폴백한다.
        cached_ble_device = _scan_cache.pop(device_id, None)
        try:
            if cached_ble_device is not None:
                try:
                    self._device.connect(cached_ble_device)
                except (
                    self._device.BLEConnectionError,
                    self._device.BLEScanFailed,
                    self._device.SensorNotFound,
                ):
                    try:
                        self._device.disconnect()
                    except Exception:
                        pass
                    self._device = PASCOBLEDevice()
                    self._device.connect_by_id(device_id)
            else:
                self._device.connect_by_id(device_id)
        except (self._device.BLEConnectionError, self._device.BLEScanFailed, self._device.SensorNotFound) as exc:
            raise SensorConnectionError(f"{self.sensor_name} 센서({device_id}) 연결 실패: {exc}") from exc

        # connect_by_id는 번호를 부분 문자열로 찾는다(pasco 내부 구현). 실제로 연결된
        # 센서의 번호(serial_id)를 다시 확인해서, 혹시 다른 센서가 잡혔다면 걸러낸다.
        actual_id = self._device.serial_id
        if actual_id and actual_id != device_id:
            self._device.disconnect()
            raise SensorConnectionError(
                f"입력한 번호({device_id})와 실제 연결된 센서 번호({actual_id})가 다릅니다"
            )
        self.device_id = actual_id or device_id
        self._last_error = None
        self._fatal_error = None

    def is_connected(self) -> bool:
        return bool(self._device and self._device.is_connected())

    def is_measuring(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    @property
    def last_error(self) -> str | None:
        return self._fatal_error or self._last_error

    @property
    def fatal_error(self) -> str | None:
        return self._fatal_error

    def start(self, interval_sec: float, keep_existing: bool = False) -> None:
        """폴링 스레드를 시작한다. pasco의 read_data()는 문서상 동기(블로킹) 호출이라
        별도 스레드에서 반복 실행해 로컬 웹 화면이 멈추지 않게 한다.

        keep_existing=True면 직전 측정의 points/events를 남기고 마지막 시각부터
        이어 잰다. 측정을 잠시 멈춘 시간은 경과 시간에 넣지 않는다."""
        if self._thread and self._thread.is_alive():
            raise SensorConnectionError("이미 측정 중입니다")
        if not self.is_connected():
            raise SensorConnectionError("connect()를 먼저 호출해야 합니다")
        if not keep_existing:
            self._points = []
            self._events = []
        self._bucket = []
        self._last_error = None
        self._fatal_error = None
        last_t = self._points[-1]["t"] if keep_existing and self._points else 0
        self._start_time = time.monotonic() - last_t
        self._stop_flag.clear()
        self._thread = threading.Thread(target=self._poll_loop, args=(interval_sec,), daemon=True)
        self._thread.start()

    def _poll_loop(self, interval_sec: float) -> None:
        """읽는 속도와 저장 간격을 떼어 놓는다(2026-07-27, 실시간 그래프 요청).

        센서는 쉬지 않고 계속 읽는다 — read_data() 자체가 블로킹 왕복(중앙 60ms,
        세션 G 실측)이라 별도로 쉬지 않아도 CPU를 100% 쓰지 않는다. 읽은 값은
        매번 _bucket에 쌓아 화면(display_points)이 바로 보게 하고, interval_sec가
        찰 때마다 그 사이 값의 평균 1점만 _points(=업로드될 데이터)에 남긴다.
        이러면 §5.2의 점 개수 한도를 그대로 지키면서도 그래프는 부드럽게 흐른다."""
        next_flush = time.monotonic() + interval_sec
        consecutive_errors = 0
        while not self._stop_flag.is_set():
            try:
                value = self._device.read_data(self.measurement)  # 2026-08-18 실물 CO2로 확인
            except (
                self._device.CommunicationError,
                self._device.MeasurementNotFound,
                self._device.DeviceNotConnected,
            ) as exc:
                consecutive_errors += 1
                self._last_error = (
                    f"센서 값을 읽지 못해 다시 시도하고 있어요 "
                    f"({consecutive_errors}/{MAX_CONSECUTIVE_READ_ERRORS})."
                )
                print(f"[sensor.py] {self._last_error} 원래 메시지: {exc}")
                if consecutive_errors >= MAX_CONSECUTIVE_READ_ERRORS:
                    self._fatal_error = (
                        "센서 연결이 끊어졌어요. 센서 연결을 해제하고 다시 검색해 주세요."
                    )
                    self._stop_flag.set()
                    break
                self._stop_flag.wait(interval_sec)
                next_flush = time.monotonic() + interval_sec
                continue
            except Exception as exc:
                self._fatal_error = (
                    "센서에서 예상하지 못한 오류가 났어요. 연결을 해제하고 다시 검색해 주세요."
                )
                print(f"[sensor.py] {self._fatal_error} 원래 메시지: {exc}")
                self._stop_flag.set()
                break

            consecutive_errors = 0
            self._last_error = None
            elapsed = time.monotonic() - self._start_time
            self._bucket.append((elapsed, value))

            if time.monotonic() >= next_flush:
                self._flush_bucket()
                next_flush += interval_sec  # 다음 시각을 누적으로 잡아 처리 시간만큼 밀리지 않게 한다

        self._flush_bucket()  # 종료 시 남은 구간도 값을 버리지 않고 마지막 점으로 저장한다

    def _flush_bucket(self) -> None:
        if not self._bucket:
            return
        avg = sum(v for _, v in self._bucket) / len(self._bucket)
        t = self._bucket[-1][0]
        self._points.append({"t": round(t, 1), "v": round(avg, 4)})
        self._bucket = []

    def record_event(self, label: str) -> None:
        if self._start_time is None:
            raise RuntimeError("측정이 시작되지 않았습니다")
        elapsed = time.monotonic() - self._start_time
        self._events.append({"t": round(elapsed, 1), "label": label})

    def latest_points(self) -> list[dict]:
        """업로드용 — 저장 간격마다 평균 낸 확정 점만 돌려준다(§5.2 개수 한도 기준)."""
        return list(self._points)

    def display_points(self) -> list[dict]:
        """실시간 그래프용 — 확정 점(_points) 뒤에 지금 채우고 있는 구간의 원시값을
        그대로 이어 붙인다. 확정 점만 보내면 그래프가 저장 간격(기본 10초)마다
        한 번씩만 움직여 "거의 실시간"으로 안 보인다. 구간 원시값 개수는
        저장 간격 하나 분량으로 자연히 제한되므로(예: 10초 ÷ 60ms ≈ 166개)
        매 폴링(0.8초)마다 통째로 보내도 화면이 느려지지 않는다."""
        tail = [{"t": round(t, 2), "v": v} for t, v in self._bucket]
        return self._points + tail

    def latest_events(self) -> list[dict]:
        return list(self._events)

    def stop(self) -> tuple[list[dict], list[dict]]:
        """측정만 멈춘다. 연결은 다음 측정을 위해 유지한다."""
        self._stop_flag.set()
        if self._thread:
            thread = self._thread
            thread.join(timeout=5)
            if thread.is_alive():
                self._fatal_error = "센서 응답이 멈춰 측정을 끝내지 못했어요. 연결을 해제해 주세요."
                raise SensorConnectionError(self._fatal_error)
            self._thread = None
        return list(self._points), list(self._events)

    def disconnect(self) -> None:
        """사용을 완전히 끝낼 때 센서 연결을 해제한다."""
        if self._thread and self._thread.is_alive():
            self.stop()
        if self._device:
            self._device.disconnect()  # 2026-08-18 실물 CO2로 확인
            self._device = None


class ManualInputSource:
    """pasco가 공식 지원하지 않는 센서(심박수·폐활량)의 대안 경로.
    학생이 값을 하나씩 입력하거나, CSV 파일을 올려서 한 번에 points를 채운다."""

    def __init__(self, sensor_name: str):
        if sensor_name not in MANUAL_ONLY_SENSORS:
            raise ValueError(f"수동 입력 대상이 아닌 센서입니다: {sensor_name}")
        self.sensor_name = sensor_name
        self.unit = MANUAL_ONLY_SENSORS[sensor_name]
        self._points: list[dict] = []
        self._events: list[dict] = []
        self._start_time: float | None = None

    def start(self, keep_existing: bool = False) -> None:
        if not keep_existing:
            self._points = []
            self._events = []
        last_t = self._points[-1]["t"] if keep_existing and self._points else 0
        self._start_time = time.monotonic() - last_t

    def add_point(self, value: float, t: float | None = None) -> None:
        """t를 안 주면 '지금'을 측정 시작 이후 경과 초로 계산한다."""
        if self._start_time is None:
            raise RuntimeError("start()를 먼저 호출해야 합니다")
        elapsed = t if t is not None else round(time.monotonic() - self._start_time, 1)
        self._points.append({"t": elapsed, "v": value})

    def record_event(self, label: str) -> None:
        if self._start_time is None:
            raise RuntimeError("start()를 먼저 호출해야 합니다")
        elapsed = time.monotonic() - self._start_time
        self._events.append({"t": round(elapsed, 1), "label": label})

    def load_csv(self, file_obj) -> None:
        """CSV 형식: t,v 두 열(첫 줄은 머리글). 기존 points를 통째로 교체한다."""
        if isinstance(file_obj, (bytes, bytearray)):
            file_obj = io.StringIO(file_obj.decode("utf-8-sig"))
        reader = csv.DictReader(file_obj)
        headers = {h.strip() for h in (reader.fieldnames or [])}
        if not {"t", "v"} <= headers:
            raise ValueError("CSV는 't,v' 두 열이 있어야 합니다 (첫 줄은 머리글)")
        points = []
        for row in reader:
            points.append({"t": float(row["t"]), "v": float(row["v"])})
        self._points = points
        if self._start_time is None:
            self._start_time = time.monotonic()

    def latest_points(self) -> list[dict]:
        return list(self._points)

    def latest_events(self) -> list[dict]:
        return list(self._events)

    def stop(self) -> tuple[list[dict], list[dict]]:
        return self._points, self._events
