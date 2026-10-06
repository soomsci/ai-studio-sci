"""실물 센서 검색·측정 검사. 서버 업로드 없이 수집기 API를 실행한다."""
import argparse
import asyncio
import json
import time

import main
import sensor
import uploader


def run():
    parser = argparse.ArgumentParser(description="실물 센서 검사")
    parser.add_argument("--sensor", choices=[*sensor.PASCO_SENSORS, *sensor.STANDARD_BLE_SENSORS])
    parser.add_argument("--device-id")
    parser.add_argument("--seconds", type=int, default=15)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 60:
        parser.error("측정 시간은 1~60초로 지정하세요.")

    if not args.sensor:
        from bleak import BleakScanner
        found = asyncio.run(BleakScanner.discover(timeout=10, return_adv=True))
        results = []
        for device, advertisement in found.values():
            name = device.name or advertisement.local_name or ""
            kind = next((kind for kind in sensor.PASCO_SENSORS if name.startswith(kind + " ")), None)
            if kind:
                results.append({"sensor": kind, "deviceId": sensor._device_id_from_name(name)})
            elif "0000180d-0000-1000-8000-00805f9b34fb" in (advertisement.service_uuids or []):
                results.append({"sensor": "HeartRate", "deviceId": sensor._hr_device_id_from_name(name)})
        print(json.dumps({"discoveredCount": len(found), "sensors": results}, ensure_ascii=False), flush=True)
        return
    if not args.device_id:
        parser.error("측정할 센서의 --device-id를 지정하세요.")

    discovered = (sensor.scan_standard_ble_heart_rate() if args.sensor == "HeartRate"
                  else sensor.scan_sensors(args.sensor))
    if not any(d["deviceId"] == args.device_id for d in discovered):
        raise RuntimeError("지정한 번호의 센서가 검색되지 않았어요. 전원과 연결 상태를 확인하세요.")
    print("센서 검색 성공", flush=True)
    client = main.app.test_client()
    main.SESSION.mode = "realtime"
    main.SESSION.meta = dict(class_id="sensor-test", group_id="g1", owner_uid="sensor-test",
                             exp_no=4 if args.sensor == "Temperature" else 1,
                             condition="실물 센서 검사", interval_sec=1)

    def post(path, body=None):
        response = client.post(path, json=body or {})
        result = response.get_json()
        if response.status_code != 200 or not result["ok"]:
            raise RuntimeError(result.get("error", str(response.status_code)))
        return result

    try:
        post("/api/channels", dict(sensorType=args.sensor, deviceId=args.device_id, label="검사", title="실물 센서 검사"))
        print("센서 연결 성공", flush=True)
        post("/api/start")
        time.sleep(args.seconds)
        post("/api/event", {"label": "검사 사건"})
        status = client.get("/api/status").get_json()
        if status.get("error"):
            raise RuntimeError(status["error"])
        post("/api/stop")
        channel = main.SESSION.channels[0]
        original = channel.source.latest_points()
        if not original:
            raise RuntimeError("측정값이 없어요.")
        post("/api/start", {"restartMode": "continue"})
        time.sleep(3)
        post("/api/stop")
        points = channel.source.latest_points()
        assert points[:len(original)] == original, "이어서 재기에서 기존 값이 바뀜"
        assert len(points) > len(original), "이어서 재기에서 새 값이 없음"
        ds = main._build_dataset(main.SESSION.meta, channel.title, channel.sensor_name,
                                 channel.source.unit, points, channel.source.latest_events(), "sensor")
        uploader.validate(ds)
        assert client.post("/api/disconnect", json={}).status_code == 409, "미저장 값 확인이 없음"
        post("/api/disconnect", {"force": True})
        assert not channel.source.is_connected(), "연결이 해제되지 않음"
        print(json.dumps({"ok": True, "sensor": args.sensor, "deviceId": args.device_id,
                          "pointCount": len(points), "unit": ds.unit,
                          "min": min(p["v"] for p in points), "max": max(p["v"] for p in points),
                          "events": len(ds.events), "continued": True, "disconnected": True}, ensure_ascii=False), flush=True)
    finally:
        main.SESSION.reset()


if __name__ == "__main__":
    run()
