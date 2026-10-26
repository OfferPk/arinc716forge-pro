#!/usr/bin/env python3
"""
ARINC716Forge Pro - Automated Test Runner & Verification Suite
10 Comprehensive Verification Tests for ARINC 716 / RTCA DO-186B Compliance
"""

import unittest
import sys
import os

# Import transceiver logic
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib.machinery import SourceFileLoader
cli_module = SourceFileLoader("arinc716_cli", os.path.join(os.path.dirname(__file__), "arinc716-cli.py")).load_module()
ARINC716Transceiver = cli_module.ARINC716Transceiver

class TestARINC716ForgePro(unittest.TestCase):
    def setUp(self):
        self.trx = ARINC716Transceiver(unit_id=1, active_freq_hz=118000000, standby_freq_hz=121500000)

    # Test 1: 8.33 kHz Channel Naming
    def test_01_channel_naming_833(self):
        ch1 = self.trx.freq_to_channel(118000000, '8.33')
        ch2 = self.trx.freq_to_channel(118008333, '8.33')
        ch3 = self.trx.freq_to_channel(118016667, '8.33')
        ch4 = self.trx.freq_to_channel(118025000, '8.33')
        self.assertEqual(ch1, "118.005", "118.000 MHz in 8.33 kHz grid must be channel 118.005")
        self.assertEqual(ch2, "118.010", "118.00833 MHz in 8.33 kHz grid must be channel 118.010")
        self.assertEqual(ch3, "118.015", "118.01667 MHz in 8.33 kHz grid must be channel 118.015")
        self.assertEqual(ch4, "118.030", "118.025 MHz in 8.33 kHz grid must be channel 118.030")

    # Test 2: 25 kHz Legacy Channel Naming
    def test_02_channel_naming_25k(self):
        ch1 = self.trx.freq_to_channel(118000000, '25')
        ch2 = self.trx.freq_to_channel(118025000, '25')
        ch3 = self.trx.freq_to_channel(121500000, '25')
        self.assertEqual(ch1, "118.000")
        self.assertEqual(ch2, "118.025")
        self.assertEqual(ch3, "121.500")

    # Test 3: VSWR Calculation Accuracy
    def test_03_vswr_calculation(self):
        # 25W forward, 0.8W reflected -> gamma = sqrt(0.8/25) = 0.178885 -> VSWR = 1.178885 / 0.821115 = 1.4357 -> 1.44
        vswr = self.trx.calculate_vswr(25.0, 0.8)
        self.assertAlmostEqual(vswr, 1.44, places=2)
        # Perfect match: 0W reflected -> VSWR = 1.00
        vswr_ideal = self.trx.calculate_vswr(25.0, 0.0)
        self.assertEqual(vswr_ideal, 1.00)

    # Test 4: High VSWR Alarm Boundary (> 3.0:1)
    def test_04_vswr_alarm_boundary(self):
        # VSWR = 3.0 occurs at gamma = 0.5 -> Pr / Pf = 0.25 -> reflected power = 6.25W for 25W forward
        vswr_safe = self.trx.calculate_vswr(25.0, 4.0) # gamma = 0.4 -> VSWR = 2.33
        vswr_alarm = self.trx.calculate_vswr(25.0, 7.0) # gamma = 0.529 -> VSWR = 3.25
        self.assertLessEqual(vswr_safe, 3.0)
        self.assertGreater(vswr_alarm, 3.0)
        
        # Verify BITE word reflects alarm
        self.trx.reflected_power_watts = 7.0
        w350 = self.trx.encode_label_350()
        bit15_alarm = (w350 >> 14) & 1
        self.assertEqual(bit15_alarm, 1, "Label 350 bit 15 must be set during High VSWR")

    # Test 5: Receiver Sensitivity & SINAD
    def test_05_receiver_sensitivity_sinad(self):
        # -107 dBm input must yield 12.0 dB SINAD
        sinad_ref = self.trx.calculate_sinad(-107.0)
        self.assertEqual(sinad_ref, 12.0, "Input at -107 dBm must yield 12.0 dB SINAD")
        # -97 dBm input (+10 dBm) yields 22.0 dB SINAD
        sinad_strong = self.trx.calculate_sinad(-97.0)
        self.assertEqual(sinad_strong, 22.0)
        # Deep fade below -120 dBm yields 0.0 dB
        sinad_floor = self.trx.calculate_sinad(-125.0)
        self.assertEqual(sinad_floor, 0.0)

    # Test 6: Squelch Gating & Override
    def test_06_squelch_gating(self):
        self.trx.squelch_defeat = False
        # At -95 dBm (24 dB SINAD), squelch must be OPEN
        self.trx.rx_input_power_dbm = -95.0
        self.assertTrue(self.trx.is_squelch_open(), "Squelch must open for 24 dB SINAD")
        
        # At -115 dBm (4 dB SINAD), squelch must be CLOSED
        self.trx.rx_input_power_dbm = -115.0
        self.assertFalse(self.trx.is_squelch_open(), "Squelch must close for 4 dB SINAD")

        # When squelch defeat is active, squelch must be forced OPEN
        self.trx.squelch_defeat = True
        self.assertTrue(self.trx.is_squelch_open(), "Squelch defeat must force audio gate open")

    # Test 7: Audio Sidetone Generation
    def test_07_sidetone_audio(self):
        # When PTT is inactive, sidetone must be inactive
        self.trx.ptt_active = False
        st_off = self.trx.get_sidetone()
        self.assertFalse(st_off['active'])

        # When PTT is active, sidetone must be active with -6 dB attenuation
        self.trx.ptt_active = True
        st_on = self.trx.get_sidetone()
        self.assertTrue(st_on['active'])
        self.assertEqual(st_on['attenuation_db'], -6.0)
        self.assertAlmostEqual(st_on['level_mw'], 25.12, places=1)

    # Test 8: CLIMAX Offset Carrier States
    def test_08_climax_carrier_offsets(self):
        valid_offsets = [0, 2500, -2500, 7500, -7500]
        for offset in valid_offsets:
            self.trx.climax_offset_hz = offset
            w270 = self.trx.encode_label_270()
            climax_bit = (w270 >> 13) & 1
            expected_bit = 1 if offset != 0 else 0
            self.assertEqual(climax_bit, expected_bit)

    # Test 9: ARINC 429 Bit 32 Odd Parity
    def test_09_arinc429_bit32_odd_parity(self):
        words = [
            self.trx.encode_label_030(),
            self.trx.encode_label_270(),
            self.trx.encode_label_350(),
            self.trx.encode_label_356()
        ]
        for w in words:
            total_ones = bin(w).count('1')
            self.assertEqual(total_ones % 2, 1, f"Word 0x{w:08X} has {total_ones} ones; must have odd parity (odd count)")

    # Test 10: 10-Point Normative Airworthiness Compliance Audit
    def test_10_normative_airworthiness_audit(self):
        audit = self.trx.run_normative_audit()
        self.assertEqual(audit['total'], 10, "Total audit rules must equal 10")
        self.assertEqual(audit['passed'], 10, "All 10 audit rules must pass")
        self.assertEqual(audit['score'], "100.0%", "Compliance score must be 100.0%")
        self.assertEqual(audit['status'], "ARINC_716_MARK3_VHF_CERTIFIED")

if __name__ == '__main__':
    runner = unittest.TextTestRunner(verbosity=2)
    suite = unittest.TestLoader().loadTestsFromTestCase(TestARINC716ForgePro)
    result = runner.run(suite)
    if not result.wasSuccessful():
        sys.exit(1)
    print("\nALL 10 VERIFICATION TESTS PASSED SUCCESSFULLY.")
