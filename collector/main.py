# main.py — 로컬 웹 화면 (세션 F)
#
# 모둠 노트북에서 이 파일(또는 PyInstaller로 묶은 실행 파일)을 실행하면
# 로컬 웹 서버가 뜨고, 브라우저로 http://127.0.0.1:5050 에 접속해 측정한다.
# 학생용 웹앱(public/index.html)과는 별개의 도구다 — 센서 연결·측정·Firestore
# 업로드만 담당한다.
#
# 여러 센서를 동시에 잴 수 있다(§12 세션 F 확장, 예: 물·식용유 온도 동시 비교).
# 센서 1대 = "채널" 1개. 채널은 번호(예: "117-880")로 정확히 지정해 연결한다 —
# sensor.py의 connect()가 스캔 순서(found[0])에 의존하지 않도록 되어 있다.
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


class _Channel:
    """실시간 센서 1대. 센서 종류·번호·이름표·제목을 함께 들고 있어서,
    화면과 업로드 양쪽에서 "이 값이 어느 센서 것인지"를 항상 알 수 있다."""

    def __init__(self, sensor_name: str, device_id: str, label: str, title: str):
        self.source = sensor.PascoSensorSource(sensor_name)
        self.sensor_name = sensor_name
        self.device_id = device_id
        self.label = label
        self.title = title

    def to_dict(self) -> dict:
        points = self.source.latest_points()
        return {
            "deviceId": self.device_id,
            "label": self.label,
            "title": self.title,
            "sensor": self.sensor_name,
            "unit": self.source.unit,
            "count": len(points),
            "latestValue": points[-1]["v"] if points else None,
        }


class _Session:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.mode: str | None = None  # "realtime" | "manual"
        self.channels: list[_Channel] = []  # mode == "realtime"
        self.manual_source = None  # mode == "manual" — sensor.ManualInputSource
        self.manual_sensor_name: str | None = None
        self.meta: dict = {}  # 학급·모둠·실험번호·조건·측정 간격 — 채널이 공유한다
        self.started_at: datetime | None = None
        self.status = "idle"  # idle | measuring | stopped


# 노트북 1대 = 그 순간 모둠 1개가 쓰는 도구라, 세션을 전역 상태 하나로 둔다.
# 여러 모둠이 같은 프로세스를 동시에 쓰는 상황은 다루지 않는다(§11 세션 F 범위 밖).
SESSION = _Session()
LOCK = threading.Lock()


@app.route("/")
def index():
    return render_template("index.html", sensors=sensor.available_sensors())


@app.route("/api/setup", methods=["POST"])
def api_setup():
    """학급·모둠·실험번호·조건·측정 간격(공유 값)을 정하고 측정 방법을 고른다."""
    data = request.get_json(force=True) or {}
    try:
        exp_no = int(data.get("expNo", 0))
    except (TypeError, ValueError):
        return jsonify(ok=False, error="실험 번호가 올바르지 않습니다"), 400

    mode = data.get("mode")
    if mode not in ("realtime", "manual"):
        return jsonify(ok=False, error="측정 방법을 골라야 합니다"), 400

    with LOCK:
        SESSION.reset()
        SESSION.meta = {
            "class_id": (data.get("classId") or "").strip(),
            "group_id": (data.get("groupId") or "").strip(),
            "owner_uid": (data.get("ownerUid") or "").strip() or f"collector-{os.getpid()}",
            "exp_no": exp_no,
            "condition": (data.get("condition") or "").strip(),
            "interval_sec": float(data.get("intervalSec") or 10),
            "title": (data.get("title") or "").strip(),  # 수동 입력 모드에서만 쓴다
        }
        SESSION.mode = mode

        if mode == "manual":
            name = data.get("sensor")
            if name not in sensor.MANUAL_ONLY_SENSORS:
                SESSION.reset()
                return jsonify(ok=False, error=f"알 수 없는 센서입니다: {name}"), 400
            SESSION.manual_source = sensor.ManualInputSource(name)
            SESSION.manual_sensor_name = name

    return jsonify(ok=True, mode=mode)


@app.route("/api/channels", methods=["POST"])
def api_add_channel():
    """실시간 센서 1대를 번호로 지정해 연결하고 채널로 추가한다."""
    data = request.get_json(force=True) or {}
    sensor_name = data.get("sensorType")
    device_id = (data.get("deviceId") or "").strip()
    label = (data.get("label") or "").strip()
    title = (data.get("title") or "").strip() or f"{label}({device_id})"

    if sensor_name not in sensor.PASCO_SENSORS:
        return jsonify(ok=False, error=f"알 수 없는 센서 종류입니다: {sensor_name}"), 400
    if not device_id or not label:
        return jsonify(ok=False, error="센서 번호와 이름표를 모두 입력하세요"), 400

    with LOCK:
        if SESSION.mode != "realtime":
            return jsonify(ok=False, error="먼저 1단계에서 실시간 측정을 선택하세요"), 400
        if any(ch.device_id == device_id for ch in SESSION.channels):
            return jsonify(ok=False, error=f"센서 {device_id}는 이미 추가했습니다"), 400

        channel = _Channel(sensor_name, device_id, label, title)
        try:
            channel.source.connect(device_id)
        except sensor.SensorConnectionError as exc:
            return jsonify(ok=False, error=str(exc)), 500

        channel.device_id = channel.source.device_id or device_id
        SESSION.channels.append(channel)
        channels = [ch.to_dict() for ch in SESSION.channels]

    return jsonify(ok=True, channels=channels)


@app.route("/api/start", methods=["POST"])
def api_start():
    with LOCK:
        try:
            if SESSION.mode == "realtime":
                if not SESSION.channels:
                    return jsonify(ok=False, error="먼저 센서를 하나 이상 추가하세요"), 400
                for ch in SESSION.channels:
                    ch.source.start(SESSION.meta["interval_sec"])
            elif SESSION.mode == "manual":
                if SESSION.manual_source is None:
                    return jsonify(ok=False, error="먼저 센서를 선택하세요"), 400
                SESSION.manual_source.start()
            else:
                return jsonify(ok=False, error="먼저 1단계를 채우세요"), 400
        except sensor.SensorConnectionError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        SESSION.started_at = datetime.now(timezone.utc)
        SESSION.status = "measuring"
    return jsonify(ok=True)


@app.route("/api/event", methods=["POST"])
def api_event():
    """모든 채널(또는 수동 입력)에 같은 순간을 함께 기록한다 — 여러 그래프를
    같은 시점 기준으로 비교해야 하기 때문이다."""
    label = ((request.get_json(force=True) or {}).get("label") or "").strip()
    if not label:
        return jsonify(ok=False, error="이벤트 이름을 입력하세요"), 400
    with LOCK:
        if SESSION.status != "measuring":
            return jsonify(ok=False, error="측정 중이 아닙니다"), 400
        if SESSION.mode == "realtime":
            for ch in SESSION.channels:
                ch.source.record_event(label)
        elif SESSION.manual_source is not None:
            SESSION.manual_source.record_event(label)
    return jsonify(ok=True)


@app.route("/api/manual-point", methods=["POST"])
def api_manual_point():
    """수동 입력 모드 전용 — 값 하나를 추가한다(심박수·폐활량 등)."""
    data = request.get_json(force=True) or {}
    with LOCK:
        if SESSION.mode != "manual" or SESSION.manual_source is None:
            return jsonify(ok=False, error="수동 입력 모드가 아닙니다"), 400
        try:
            value = float(data["value"])
        except (KeyError, TypeError, ValueError):
            return jsonify(ok=False, error="숫자 값을 입력하세요"), 400
        SESSION.manual_source.add_point(value)
        SESSION.status = "measuring"
    return jsonify(ok=True)


@app.route("/api/csv-upload", methods=["POST"])
def api_csv_upload():
    """수동 입력 모드 전용 — CSV로 points를 한 번에 채운다."""
    with LOCK:
        if SESSION.mode != "manual" or SESSION.manual_source is None:
            return jsonify(ok=False, error="수동 입력 모드가 아닙니다"), 400
        file = request.files.get("file")
        if not file:
            return jsonify(ok=False, error="파일이 없습니다"), 400
        try:
            SESSION.manual_source.load_csv(file.read())
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        SESSION.started_at = SESSION.started_at or datetime.now(timezone.utc)
        SESSION.status = "measuring"
        count = len(SESSION.manual_source.latest_points())
    return jsonify(ok=True, count=count)


@app.route("/api/status")
def api_status():
    with LOCK:
        if SESSION.mode == "realtime":
            channels = [ch.to_dict() for ch in SESSION.channels]
            return jsonify(ok=True, status=SESSION.status, channels=channels)
        points = SESSION.manual_source.latest_points() if SESSION.manual_source else []
        return jsonify(ok=True, status=SESSION.status, points=points)


@app.route("/api/stop", methods=["POST"])
def api_stop():
    with LOCK:
        if SESSION.mode == "realtime":
            if not SESSION.channels:
                return jsonify(ok=False, error="측정 중이 아닙니다"), 400
            counts = [len(ch.source.stop()[0]) for ch in SESSION.channels]
            SESSION.status = "stopped"
            return jsonify(ok=True, counts=counts)
        if SESSION.manual_source is None:
            return jsonify(ok=False, error="측정 중이 아닙니다"), 400
        points, _events = SESSION.manual_source.stop()
        SESSION.status = "stopped"
    return jsonify(ok=True, count=len(points))


def _build_dataset(meta: dict, title: str, sensor_name: str, unit: str,
                    points: list[dict], events: list[dict], source_kind: str) -> uploader.Dataset:
    return uploader.Dataset(
        class_id=meta["class_id"],
        group_id=meta["group_id"],
        owner_uid=meta["owner_uid"],
        exp_no=meta["exp_no"],
        title=title,
        condition=meta["condition"],
        sensor=sensor_name,
        unit=unit,
        started_at=SESSION.started_at or datetime.now(timezone.utc),
        interval_sec=meta["interval_sec"],
        points=points,
        events=events,
        source=source_kind,
        status="submitted",
    )


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """실시간 모드는 채널마다 datasets 문서 1개(§5.2 — 측정 1회 = 문서 1개,
    센서 하나당 sensor·unit은 단수). 수동 모드는 기존처럼 문서 1개."""
    with LOCK:
        meta = SESSION.meta

        if SESSION.mode == "realtime":
            if not SESSION.channels:
                return jsonify(ok=False, error="측정 데이터가 없습니다"), 400
            datasets = [
                (
                    ch,
                    _build_dataset(
                        meta, ch.title, ch.sensor_name, ch.source.unit,
                        ch.source.latest_points(), ch.source.latest_events(), "sensor",
                    ),
                )
                for ch in SESSION.channels
            ]
            try:
                for _ch, ds in datasets:
                    uploader.validate(ds)  # 하나라도 §5 스키마를 어기면 아무것도 올리지 않는다
            except uploader.SchemaError as exc:
                return jsonify(ok=False, error=str(exc)), 400

            results = []
            try:
                for ch, ds in datasets:
                    dataset_id = uploader.upload_dataset(ds)
                    results.append({"deviceId": ch.device_id, "label": ch.label, "datasetId": dataset_id})
            except (FileNotFoundError, ModuleNotFoundError) as exc:
                return jsonify(ok=False, error=str(exc)), 500
            return jsonify(ok=True, results=results)

        if SESSION.manual_source is None:
            return jsonify(ok=False, error="측정 데이터가 없습니다"), 400
        title = meta.get("title") or SESSION.manual_sensor_name or "측정"
        ds = _build_dataset(
            meta, title, SESSION.manual_sensor_name, SESSION.manual_source.unit,
            SESSION.manual_source.latest_points(), SESSION.manual_source.latest_events(), "manual",
        )
        try:
            dataset_id = uploader.upload_dataset(ds)
        except uploader.SchemaError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except (FileNotFoundError, ModuleNotFoundError) as exc:
            return jsonify(ok=False, error=str(exc)), 500

    return jsonify(ok=True, datasetId=dataset_id)


def main() -> None:
    app.run(host="127.0.0.1", port=5050, debug=False)


if __name__ == "__main__":
    main()
