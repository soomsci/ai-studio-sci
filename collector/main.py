# main.py — 로컬 웹 화면 (세션 F)
#
# 모둠 노트북에서 이 파일(또는 PyInstaller로 묶은 실행 파일)을 실행하면
# 로컬 웹 서버가 뜨고, 브라우저로 http://127.0.0.1:5050 에 접속해 측정한다.
# 학생용 웹앱(public/index.html)과는 별개의 도구다 — 센서 연결·측정·Firestore
# 업로드만 담당한다.
#
# 실행: python main.py

from __future__ import annotations

import os
import threading
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template, request

import sensor
import uploader

app = Flask(__name__)

# 노트북 1대 = 그 순간 모둠 1개가 쓰는 도구라, 세션을 전역 상태 하나로 둔다.
# 여러 모둠이 같은 프로세스를 동시에 쓰는 상황은 다루지 않는다(§11 세션 F 범위 밖).
class _Session:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.source = None  # sensor.PascoSensorSource | sensor.ManualInputSource | None
        self.sensor_name: str | None = None
        self.unit: str | None = None
        self.meta: dict = {}
        self.started_at: datetime | None = None
        self.status = "idle"  # idle | connected | measuring | stopped


SESSION = _Session()
LOCK = threading.Lock()


@app.route("/")
def index():
    return render_template("index.html", sensors=sensor.available_sensors())


@app.route("/api/setup", methods=["POST"])
def api_setup():
    """측정 메타데이터(§5 datasets 필드)를 받고 센서 소스를 준비한다."""
    data = request.get_json(force=True) or {}
    name = data.get("sensor")

    with LOCK:
        SESSION.reset()
        try:
            exp_no = int(data.get("expNo", 0))
        except (TypeError, ValueError):
            return jsonify(ok=False, error="실험 번호가 올바르지 않습니다"), 400

        SESSION.meta = {
            "class_id": (data.get("classId") or "").strip(),
            "group_id": (data.get("groupId") or "").strip(),
            "owner_uid": (data.get("ownerUid") or "").strip() or f"collector-{os.getpid()}",
            "exp_no": exp_no,
            "title": (data.get("title") or "").strip(),
            "condition": (data.get("condition") or "").strip(),
            "interval_sec": float(data.get("intervalSec") or 10),
        }

        if name in sensor.PASCO_SENSORS:
            SESSION.source = sensor.PascoSensorSource(name)
        elif name in sensor.MANUAL_ONLY_SENSORS:
            SESSION.source = sensor.ManualInputSource(name)
        else:
            SESSION.reset()
            return jsonify(ok=False, error=f"알 수 없는 센서입니다: {name}"), 400

        SESSION.sensor_name = name
        SESSION.unit = SESSION.source.unit
        SESSION.status = "idle"

    return jsonify(ok=True, unit=SESSION.unit, realtime=name in sensor.PASCO_SENSORS)


@app.route("/api/connect", methods=["POST"])
def api_connect():
    """실시간(pasco) 센서 전용 — 블루투스 연결을 시도한다."""
    with LOCK:
        if not isinstance(SESSION.source, sensor.PascoSensorSource):
            return jsonify(ok=False, error="실시간 연결 대상 센서가 아닙니다"), 400
        device_id = (request.get_json(silent=True) or {}).get("deviceId")
        try:
            SESSION.source.connect(device_id)
        except sensor.SensorConnectionError as exc:
            return jsonify(ok=False, error=str(exc)), 500
        SESSION.status = "connected"
    return jsonify(ok=True)


@app.route("/api/start", methods=["POST"])
def api_start():
    with LOCK:
        if SESSION.source is None:
            return jsonify(ok=False, error="먼저 센서를 선택하세요"), 400
        try:
            if isinstance(SESSION.source, sensor.PascoSensorSource):
                SESSION.source.start(SESSION.meta["interval_sec"])
            else:
                SESSION.source.start()
        except sensor.SensorConnectionError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        SESSION.started_at = datetime.now(timezone.utc)
        SESSION.status = "measuring"
    return jsonify(ok=True)


@app.route("/api/event", methods=["POST"])
def api_event():
    label = ((request.get_json(force=True) or {}).get("label") or "").strip()
    if not label:
        return jsonify(ok=False, error="이벤트 이름을 입력하세요"), 400
    with LOCK:
        if SESSION.source is None or SESSION.status != "measuring":
            return jsonify(ok=False, error="측정 중이 아닙니다"), 400
        SESSION.source.record_event(label)
    return jsonify(ok=True)


@app.route("/api/manual-point", methods=["POST"])
def api_manual_point():
    """수동 입력 센서 전용 — 값 하나를 추가한다(심박수·폐활량 등)."""
    data = request.get_json(force=True) or {}
    with LOCK:
        if not isinstance(SESSION.source, sensor.ManualInputSource):
            return jsonify(ok=False, error="수동 입력 대상 센서가 아닙니다"), 400
        try:
            value = float(data["value"])
        except (KeyError, TypeError, ValueError):
            return jsonify(ok=False, error="숫자 값을 입력하세요"), 400
        SESSION.source.add_point(value)
        SESSION.status = "measuring"
    return jsonify(ok=True)


@app.route("/api/csv-upload", methods=["POST"])
def api_csv_upload():
    """수동 입력 센서 전용 — CSV로 points를 한 번에 채운다."""
    with LOCK:
        if not isinstance(SESSION.source, sensor.ManualInputSource):
            return jsonify(ok=False, error="수동 입력 대상 센서가 아닙니다"), 400
        file = request.files.get("file")
        if not file:
            return jsonify(ok=False, error="파일이 없습니다"), 400
        try:
            SESSION.source.load_csv(file.read())
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        SESSION.started_at = SESSION.started_at or datetime.now(timezone.utc)
        SESSION.status = "measuring"
        count = len(SESSION.source.latest_points())
    return jsonify(ok=True, count=count)


@app.route("/api/status")
def api_status():
    with LOCK:
        points = SESSION.source.latest_points() if SESSION.source else []
        return jsonify(ok=True, status=SESSION.status, points=points)


@app.route("/api/stop", methods=["POST"])
def api_stop():
    with LOCK:
        if SESSION.source is None:
            return jsonify(ok=False, error="측정 중이 아닙니다"), 400
        points, _events = SESSION.source.stop()
        SESSION.status = "stopped"
    return jsonify(ok=True, count=len(points))


@app.route("/api/upload", methods=["POST"])
def api_upload():
    with LOCK:
        if SESSION.source is None:
            return jsonify(ok=False, error="측정 데이터가 없습니다"), 400

        meta = SESSION.meta
        ds = uploader.Dataset(
            class_id=meta["class_id"],
            group_id=meta["group_id"],
            owner_uid=meta["owner_uid"],
            exp_no=meta["exp_no"],
            title=meta["title"],
            condition=meta["condition"],
            sensor=SESSION.sensor_name,
            unit=SESSION.unit,
            started_at=SESSION.started_at or datetime.now(timezone.utc),
            interval_sec=meta["interval_sec"],
            points=SESSION.source.latest_points(),
            events=SESSION.source.latest_events(),
            source="sensor" if isinstance(SESSION.source, sensor.PascoSensorSource) else "manual",
            status="submitted",
        )
        try:
            dataset_id = uploader.upload_dataset(ds)
        except uploader.SchemaError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except FileNotFoundError as exc:
            return jsonify(ok=False, error=str(exc)), 500
        except ModuleNotFoundError as exc:
            return jsonify(
                ok=False,
                error=f"필요한 패키지가 설치되지 않았습니다: {exc}. "
                "pip install -r requirements.txt를 실행하세요.",
            ), 500

    return jsonify(ok=True, datasetId=dataset_id)


def main() -> None:
    app.run(host="127.0.0.1", port=5050, debug=False)


if __name__ == "__main__":
    main()
