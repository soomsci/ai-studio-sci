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
# measurement 값은 pasco 공개 문서에 정확한 문자열이 나와 있지 않다.
# 실제 센서 연결 후 device.get_measurement_list()로 확인해서 맞춰야 한다.
# → 센서 입수 후 테스트 필요.
PASCO_SENSORS = {
    "CO2": {"measurement": "CO2", "unit": "ppm"},
    "Temperature": {"measurement": "Temperature", "unit": "℃"},
    "Light": {"measurement": "Light", "unit": "lx"},
    "Current": {"measurement": "Current", "unit": "A"},
    "Voltage": {"measurement": "Voltage", "unit": "V"},
}

# pasco 공식 지원 목록에 없는 센서 — 수동 입력/CSV 경로만 제공한다 (CLAUDE.md 전제 2).
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


class PascoSensorSource:
    """pasco 라이브러리로 실시간 연결되는 센서.

    메서드 이름·시그니처(scan/connect/connect_by_id/read_data/disconnect 등)는
    설치된 pasco 0.3.65의 실제 클래스로 대조 확인했다. 다만 **블루투스로 실제
    센서를 찾아 연결하는 동작 자체**는 하드웨어 없이는 확인할 수 없다.
    → 센서 입수 후 실제 연결 테스트 필요.
    """

    def __init__(self, sensor_name: str):
        if sensor_name not in PASCO_SENSORS:
            raise ValueError(f"pasco로 실시간 연결할 수 없는 센서입니다: {sensor_name}")
        self.sensor_name = sensor_name
        self.measurement = PASCO_SENSORS[sensor_name]["measurement"]
        self.unit = PASCO_SENSORS[sensor_name]["unit"]
        self._device = None
        self._points: list[dict] = []
        self._events: list[dict] = []
        self._start_time: float | None = None
        self._stop_flag = threading.Event()
        self._thread: threading.Thread | None = None

    def connect(self, device_id: str | None = None) -> None:
        """블루투스로 센서를 찾아 연결한다. device_id를 주면 스캔 없이 바로 연결한다.
        ⚠ 센서 입수 후 실제 연결 테스트 필요."""
        # pasco가 설치되지 않은 환경(예: 센서 없이 대안 경로만 쓰는 경우)에서도
        # 이 모듈 자체는 import되어야 하므로 지연 import한다.
        from pasco.pasco_ble_device import PASCOBLEDevice

        self._device = PASCOBLEDevice()
        try:
            if device_id:
                self._device.connect_by_id(device_id)
            else:
                found = self._device.scan(self.sensor_name)
                if not found:
                    raise SensorConnectionError(f"{self.sensor_name} 센서를 찾지 못했습니다")
                self._device.connect(found[0])
        except (self._device.BLEScanFailed, self._device.BLEConnectionError, self._device.SensorNotFound) as exc:
            raise SensorConnectionError(f"{self.sensor_name} 센서 연결 실패: {exc}") from exc

    def is_connected(self) -> bool:
        return bool(self._device and self._device.is_connected())

    def start(self, interval_sec: float) -> None:
        """폴링 스레드를 시작한다. pasco의 read_data()는 문서상 동기(블로킹) 호출이라
        별도 스레드에서 반복 실행해 로컬 웹 화면이 멈추지 않게 한다."""
        if not self._device:
            raise SensorConnectionError("connect()를 먼저 호출해야 합니다")
        self._points = []
        self._events = []
        self._start_time = time.monotonic()
        self._stop_flag.clear()
        self._thread = threading.Thread(target=self._poll_loop, args=(interval_sec,), daemon=True)
        self._thread.start()

    def _poll_loop(self, interval_sec: float) -> None:
        while not self._stop_flag.is_set():
            elapsed = time.monotonic() - self._start_time
            try:
                value = self._device.read_data(self.measurement)  # ⚠ 센서 입수 후 테스트 필요
            except (
                self._device.CommunicationError,
                self._device.MeasurementNotFound,
                self._device.DeviceNotConnected,
            ) as exc:
                print(f"[sensor.py] 측정값 읽기 실패, 다음 주기에 재시도: {exc}")
                self._stop_flag.wait(interval_sec)
                continue
            self._points.append({"t": round(elapsed, 1), "v": value})
            self._stop_flag.wait(interval_sec)

    def record_event(self, label: str) -> None:
        if self._start_time is None:
            raise RuntimeError("측정이 시작되지 않았습니다")
        elapsed = time.monotonic() - self._start_time
        self._events.append({"t": round(elapsed, 1), "label": label})

    def latest_points(self) -> list[dict]:
        """측정 중 실시간 그래프 갱신용 — 현재까지 쌓인 점을 반환한다."""
        return list(self._points)

    def latest_events(self) -> list[dict]:
        return list(self._events)

    def stop(self) -> tuple[list[dict], list[dict]]:
        self._stop_flag.set()
        if self._thread:
            self._thread.join(timeout=5)
        if self._device:
            self._device.disconnect()  # ⚠ 센서 입수 후 테스트 필요
        return self._points, self._events


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

    def start(self) -> None:
        self._points = []
        self._events = []
        self._start_time = time.monotonic()

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
