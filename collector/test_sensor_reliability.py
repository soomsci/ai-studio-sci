"""센서 검색 캐시와 종료 오류 경로를 실제 BLE 없이 검증한다."""

from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

import sensor


class SensorReliabilityTest(unittest.TestCase):
    def tearDown(self) -> None:
        sensor._scan_cache.clear()

    def test_empty_scan_is_retried_once(self) -> None:
        calls = []
        ble = types.SimpleNamespace(name="Temperature 123-456>18")

        class FakePascoDevice:
            class BLEScanFailed(Exception):
                pass

            def scan(self, name):
                calls.append(name)
                return [] if len(calls) == 1 else [ble]

        fake_module = types.SimpleNamespace(PASCOBLEDevice=FakePascoDevice)
        with patch.dict(sys.modules, {"pasco.pasco_ble_device": fake_module}):
            found = sensor.scan_sensors("Temperature")

        self.assertEqual(calls, ["Temperature", "Temperature"])
        self.assertEqual(found[0]["deviceId"], "123-456")

    def test_stale_cached_device_falls_back_to_id_scan(self) -> None:
        instances = []

        class FakePascoDevice:
            class BLEConnectionError(Exception):
                pass

            class BLEScanFailed(Exception):
                pass

            class SensorNotFound(Exception):
                pass

            def __init__(self):
                self.serial_id = "123-456"
                self.connected_by_id = False
                instances.append(self)

            def connect(self, _cached):
                raise self.BLEConnectionError("stale")

            def connect_by_id(self, device_id):
                self.connected_by_id = device_id == "123-456"

            def disconnect(self):
                pass

            def is_connected(self):
                return self.connected_by_id

        sensor._scan_cache["123-456"] = object()
        fake_module = types.SimpleNamespace(PASCOBLEDevice=FakePascoDevice)
        with patch.dict(sys.modules, {"pasco.pasco_ble_device": fake_module}):
            source = sensor.PascoSensorSource("Temperature")
            source.connect("123-456")

        self.assertEqual(len(instances), 2)
        self.assertTrue(instances[-1].connected_by_id)
        self.assertNotIn("123-456", sensor._scan_cache)

    def test_stop_timeout_keeps_thread_reference_and_reports_error(self) -> None:
        class StuckThread:
            def join(self, timeout):
                self.timeout = timeout

            def is_alive(self):
                return True

        source = sensor.PascoSensorSource("Temperature")
        source._thread = StuckThread()

        with self.assertRaisesRegex(sensor.SensorConnectionError, "응답이 멈춰"):
            source.stop()
        self.assertIsNotNone(source._thread)
        self.assertIn("응답이 멈춰", source.fatal_error)


if __name__ == "__main__":
    unittest.main()
