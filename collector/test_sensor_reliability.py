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

    def test_pasco_sensors_measurement_names_match_hardware(self) -> None:
        """2026-08-18 실물 CO2·조도·압력 센서로 get_measurement_list()를 확인한 값.
        여기서 어긋나면 read_data()가 MeasurementNotFound로 조용히 죽는다."""
        self.assertEqual(sensor.PASCO_SENSORS["CO2"]["measurement"], "CO2Concentration")
        self.assertEqual(sensor.PASCO_SENSORS["Light"]["measurement"], "Illuminance")
        self.assertIn("Pressure", sensor.PASCO_SENSORS)
        self.assertEqual(sensor.PASCO_SENSORS["Pressure"]["measurement"], "Pressure")
        self.assertEqual(sensor.PASCO_SENSORS["Pressure"]["unit"], "psi")


class StandardBleHeartRateTest(unittest.TestCase):
    """표준 BLE 심박수(0x180D) 경로의 순수 로직만 검증한다 — 실제 연결은
    2026-08-18 Polar H9 실물로 별도 확인함(scan→connect→start→stop→disconnect)."""

    def test_device_id_from_name_takes_last_token(self) -> None:
        self.assertEqual(sensor._hr_device_id_from_name("Polar H9 AEC59026"), "AEC59026")
        self.assertIsNone(sensor._hr_device_id_from_name(None))
        self.assertIsNone(sensor._hr_device_id_from_name(""))

    def test_parse_hr_uint8_format(self) -> None:
        # flags=0x00(0비트=0) → 두 번째 바이트가 심박수(UINT8). 실물 Polar H9 응답 형식.
        src = sensor.StandardBleHeartRateSource.__new__(sensor.StandardBleHeartRateSource)
        self.assertEqual(src._parse_hr(bytearray([0x00, 75])), 75.0)

    def test_parse_hr_uint16_format(self) -> None:
        # flags=0x01(0비트=1) → 이어지는 2바이트(리틀엔디안)가 심박수.
        src = sensor.StandardBleHeartRateSource.__new__(sensor.StandardBleHeartRateSource)
        self.assertEqual(src._parse_hr(bytearray([0x01, 0x4B, 0x00])), 75.0)


if __name__ == "__main__":
    unittest.main()
