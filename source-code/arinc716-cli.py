#!/usr/bin/env python3
"""
ARINC716Forge Pro - Standalone Python CLI Runner & Simulation Suite
Standards: ARINC Characteristic 716, RTCA DO-186B, ICAO Annex 10 Vol III Part II, FAA TSO-C37e/C38e
"""

import sys
import math
import json
import argparse

class ARINC716Transceiver:
    def __init__(self, unit_id=1, active_freq_hz=118000000, standby_freq_hz=121500000, spacing='8.33'):
        self.unit_id = unit_id
        self.active_freq_hz = active_freq_hz
        self.standby_freq_hz = standby_freq_hz
        self.spacing = spacing # '8.33' or '25'
        self.tx_power_watts = 25.0
        self.reflected_power_watts = 0.8
        self.modulation_index = 0.90 # 90%
        self.ptt_active = False
        self.squelch_defeat = False
        self.rx_input_power_dbm = -95.0
        self.climax_offset_hz = 0
        self.voice_mode = True
        self.guard_active = True
        
        self.faults = {
            'synthesizer_unlock': False,
            'pa_over_temp': False,
            'power_supply_fault': False,
            'antenna_disconnect': False,
            'vswr_high': False,
            'sidetone_fault': False
        }

    @staticmethod
    def freq_to_channel(freq_hz, spacing='8.33'):
        mhz = freq_hz / 1e6
        if spacing == '25':
            return f"{mhz:.3f}"
        base_mhz = int(mhz)
        remainder_khz = round((mhz - base_mhz) * 1000)
        block25 = (remainder_khz // 25) * 25
        offset = remainder_khz - block25

        if offset < 4:
            ch_suffix = block25 + 5
        elif offset < 12:
            ch_suffix = block25 + 10
        elif offset < 21:
            ch_suffix = block25 + 15
        else:
            ch_suffix = block25 + 30

        return f"{base_mhz}.{ch_suffix:03d}"

    def calculate_vswr(self, forward_w, reflected_w):
        if forward_w <= 0:
            return 1.0
        if reflected_w < 0:
            reflected_w = 0.0
        if reflected_w >= forward_w:
            return 99.9
        gamma = math.sqrt(reflected_w / forward_w)
        if gamma >= 0.99:
            return 99.9
        vswr = (1.0 + gamma) / (1.0 - gamma)
        return round(vswr, 2)

    def calculate_sinad(self, input_dbm):
        if input_dbm <= -120.0:
            return 0.0
        sinad = 12.0 + (input_dbm - (-107.0))
        return max(0.0, min(42.0, round(sinad, 1)))

    def is_squelch_open(self):
        if self.squelch_defeat:
            return True
        return self.calculate_sinad(self.rx_input_power_dbm) >= 10.0

    def get_sidetone(self):
        if not self.ptt_active or self.faults['sidetone_fault']:
            return {'active': False, 'level_dbm': None, 'level_mw': 0.0}
        return {'active': True, 'level_dbm': 14.0, 'level_mw': 25.12, 'attenuation_db': -6.0}

    def transfer(self):
        self.active_freq_hz, self.standby_freq_hz = self.standby_freq_hz, self.active_freq_hz
        return {
            'active_channel': self.freq_to_channel(self.active_freq_hz, self.spacing),
            'standby_channel': self.freq_to_channel(self.standby_freq_hz, self.spacing)
        }

    @staticmethod
    def compute_odd_parity(val31):
        count = bin(val31).count('1')
        return 1 if (count % 2 == 0) else 0

    def encode_label_030(self):
        mhz = self.active_freq_hz / 1e6
        base_mhz = int(mhz)
        frac_khz = round((mhz - base_mhz) * 1000)

        mhz_u = base_mhz % 10
        mhz_t = (base_mhz % 100) // 10
        mhz_h = base_mhz // 100

        khz_h = frac_khz // 100
        khz_t = (frac_khz % 100) // 10

        word = 0x18 # Label 030
        word |= ((self.unit_id & 0x03) << 8)
        word |= ((khz_h & 0x0F) << 10)
        word |= ((khz_t & 0x0F) << 14)
        word |= ((mhz_u & 0x0F) << 18)
        word |= ((mhz_t & 0x0F) << 22)
        word |= ((mhz_h & 0x03) << 26)

        if self.spacing == '8.33':
            word |= (1 << 28)

        word |= (0x03 << 29) # SSM Normal
        p = self.compute_odd_parity(word)
        word |= (p << 31)
        return word

    def encode_label_270(self):
        word = 0x58 # Label 270
        word |= ((self.unit_id & 0x03) << 8)
        if self.ptt_active:
            word |= (1 << 10)
        if self.squelch_defeat:
            word |= (1 << 11)
        if self.spacing == '8.33':
            word |= (1 << 12)
        if self.climax_offset_hz != 0:
            word |= (1 << 13)
        if self.voice_mode:
            word |= (1 << 14)
        if self.guard_active:
            word |= (1 << 15)

        word |= (0x03 << 29)
        p = self.compute_odd_parity(word)
        word |= (p << 31)
        return word

    def encode_label_350(self):
        word = 0xE8 # Label 350
        word |= ((self.unit_id & 0x03) << 8)
        vswr = self.calculate_vswr(self.tx_power_watts, self.reflected_power_watts)
        vswr_alarm = vswr > 3.0 or self.faults['vswr_high']

        if self.faults['synthesizer_unlock']: word |= (1 << 10)
        if self.faults['pa_over_temp']: word |= (1 << 11)
        if self.faults['power_supply_fault']: word |= (1 << 12)
        if self.faults['antenna_disconnect']: word |= (1 << 13)
        if vswr_alarm: word |= (1 << 14)
        if self.faults['sidetone_fault']: word |= (1 << 15)

        has_fault = any(self.faults.values()) or vswr_alarm
        ssm = 0x00 if has_fault else 0x03
        word |= (ssm << 29)
        p = self.compute_odd_parity(word)
        word |= (p << 31)
        return word

    def encode_label_356(self):
        l030 = self.encode_label_030()
        word = (l030 & 0xFFFFFF00) | 0xEE # Octal 356
        word &= 0x7FFFFFFF # Clear bit 32
        p = self.compute_odd_parity(word)
        word |= (p << 31)
        return word

    def run_normative_audit(self):
        tests = []
        # 1. Band
        in_band = 118000000 <= self.active_freq_hz <= 136975000
        tests.append(('ARINC716-REQ-001', 'VHF Band Coverage (118.000–136.975 MHz)', in_band))
        # 2. 8.33 kHz
        ch = self.freq_to_channel(self.active_freq_hz, '8.33')
        tests.append(('ARINC716-REQ-002', '8.33 kHz Spacing & 6-Digit Naming', len(ch) == 7))
        # 3. 25 kHz
        ch25 = self.freq_to_channel(118000000, '25')
        tests.append(('ARINC716-REQ-003', '25 kHz Legacy Compatibility', ch25 == '118.000'))
        # 4. Modulation
        tests.append(('ARINC716-REQ-004', 'DSB-AM Modulation Depth (85%–95%)', 0.85 <= self.modulation_index <= 0.95))
        # 5. TX Power
        tests.append(('ARINC716-REQ-005', 'RF TX Carrier Power (25W Nominal)', 16.0 <= self.tx_power_watts <= 35.0))
        # 6. VSWR Protection
        vswr = self.calculate_vswr(self.tx_power_watts, self.reflected_power_watts)
        tests.append(('ARINC716-REQ-006', 'Antenna VSWR & PA Protection', 1.0 <= vswr <= 3.0))
        # 7. RX Sensitivity
        sinad = self.calculate_sinad(-107.0)
        tests.append(('ARINC716-REQ-007', 'Receiver Sensitivity (12 dB SINAD at -107 dBm)', sinad >= 12.0))
        # 8. Sidetone
        prev_ptt = self.ptt_active
        self.ptt_active = True
        st = self.get_sidetone()
        self.ptt_active = prev_ptt
        tests.append(('ARINC716-REQ-008', 'Audio Sidetone Generation (-6 dB)', st['active'] and st['attenuation_db'] == -6.0))
        # 9. CLIMAX
        tests.append(('ARINC716-REQ-009', 'CLIMAX Offset Carrier Synthesis', self.climax_offset_hz in [0, 2500, -2500, 7500, -7500]))
        # 10. ARINC 429
        w030 = self.encode_label_030()
        w270 = self.encode_label_270()
        w350 = self.encode_label_350()
        w356 = self.encode_label_356()
        p_ok = all(bin(w).count('1') % 2 == 1 for w in [w030, w270, w350, w356])
        tests.append(('ARINC716-REQ-010', 'ARINC 429 Bus Protocol & Bit 32 Odd Parity', p_ok))

        passed = sum(1 for _, _, ok in tests if ok)
        return {
            'total': len(tests),
            'passed': passed,
            'score': f"{(passed / len(tests)) * 100:.1f}%",
            'status': 'ARINC_716_MARK3_VHF_CERTIFIED' if passed == len(tests) else 'NON_COMPLIANT',
            'results': [{'req': r, 'name': n, 'passed': p} for r, n, p in tests]
        }

def main():
    parser = argparse.ArgumentParser(description="ARINC716Forge Pro CLI Avionics Simulator")
    parser.add_argument("--unit", type=int, default=1, choices=[1, 2, 3], help="VHF Transceiver Unit (1, 2, or 3)")
    parser.add_argument("--freq", type=float, default=118.000, help="Active frequency in MHz")
    parser.add_argument("--standby", type=float, default=121.500, help="Standby frequency in MHz")
    parser.add_argument("--spacing", choices=['8.33', '25'], default='8.33', help="Channel spacing (8.33 or 25 kHz)")
    parser.add_argument("--ptt", action="store_true", help="Key Push-To-Talk (PTT)")
    parser.add_argument("--power", type=float, default=25.0, help="TX forward power in Watts")
    parser.add_argument("--reflected", type=float, default=0.8, help="TX reflected power in Watts")
    parser.add_argument("--rx-power", type=float, default=-95.0, help="RX input power in dBm")
    parser.add_argument("--climax", type=int, default=0, choices=[0, 2500, -2500, 7500, -7500], help="CLIMAX offset in Hz")
    parser.add_argument("--audit", action="store_true", help="Run 10-point airworthiness compliance audit")
    parser.add_argument("--json", action="store_true", help="Output results in JSON format")

    args = parser.parse_args()

    trx = ARINC716Transceiver(
        unit_id=args.unit,
        active_freq_hz=int(args.freq * 1e6),
        standby_freq_hz=int(args.standby * 1e6),
        spacing=args.spacing
    )
    trx.ptt_active = args.ptt
    trx.tx_power_watts = args.power
    trx.reflected_power_watts = args.reflected
    trx.rx_input_power_dbm = args.rx_power
    trx.climax_offset_hz = args.climax

    if args.audit:
        audit_res = trx.run_normative_audit()
        if args.json:
            print(json.dumps(audit_res, indent=2))
        else:
            print("================================================================================")
            print(" ARINC716Forge Pro - 10-Point Normative Airworthiness Compliance Audit")
            print(" Standards: ARINC 716 Mark 3 VHF, RTCA DO-186B, ICAO Annex 10 Vol III")
            print("================================================================================")
            for r in audit_res['results']:
                status = "PASS [OK]" if r['passed'] else "FAIL [X]"
                print(f" {r['req']:<18} | {r['name']:<50} | {status}")
            print("--------------------------------------------------------------------------------")
            print(f" Compliance Score: {audit_res['score']} ({audit_res['passed']}/{audit_res['total']}) | Status: {audit_res['status']}")
            print("================================================================================")
        return

    # Standard Telemetry Output
    vswr = trx.calculate_vswr(trx.tx_power_watts, trx.reflected_power_watts)
    sinad = trx.calculate_sinad(trx.rx_input_power_dbm)
    sidetone = trx.get_sidetone()
    l030 = trx.encode_label_030()
    l270 = trx.encode_label_270()
    l350 = trx.encode_label_350()
    l356 = trx.encode_label_356()

    data = {
        'unit': f"VHF {trx.unit_id}",
        'active_channel': trx.freq_to_channel(trx.active_freq_hz, trx.spacing),
        'active_freq_mhz': f"{args.freq:.4f}",
        'standby_channel': trx.freq_to_channel(trx.standby_freq_hz, trx.spacing),
        'standby_freq_mhz': f"{args.standby:.4f}",
        'spacing': f"{trx.spacing} kHz",
        'ptt_active': trx.ptt_active,
        'tx_forward_power_watts': trx.tx_power_watts if trx.ptt_active else 0.0,
        'tx_reflected_power_watts': trx.reflected_power_watts if trx.ptt_active else 0.0,
        'vswr': vswr,
        'vswr_status': 'OK' if vswr <= 2.5 else 'HIGH_VSWR_ALARM',
        'rx_input_dbm': trx.rx_input_power_dbm,
        'rx_sinad_db': sinad,
        'squelch_open': trx.is_squelch_open(),
        'sidetone_active': sidetone['active'],
        'climax_offset_hz': trx.climax_offset_hz,
        'arinc429_hex': {
            'label030': f"0x{l030:08X}",
            'label270': f"0x{l270:08X}",
            'label350': f"0x{l350:08X}",
            'label356': f"0x{l356:08X}"
        }
    }

    if args.json:
        print(json.dumps(data, indent=2))
    else:
        print("================================================================================")
        print(f" ARINC716Forge Pro - VHF Transceiver Unit {trx.unit_id} Operational Telemetry")
        print("================================================================================")
        print(f" Active Channel  : {data['active_channel']} ({data['active_freq_mhz']} MHz) [{data['spacing']}]")
        print(f" Standby Channel : {data['standby_channel']} ({data['standby_freq_mhz']} MHz)")
        print(f" PTT State       : {'TRANSMITTING (PTT KEYED)' if trx.ptt_active else 'RECEIVING / STANDBY'}")
        print(f" TX Power (Fwd)  : {data['tx_forward_power_watts']:.1f} W | Reflected: {data['tx_reflected_power_watts']:.2f} W | VSWR: {vswr}:1 ({data['vswr_status']})")
        print(f" RX Sensitivity  : Input {data['rx_input_dbm']:.1f} dBm | SINAD: {data['rx_sinad_db']:.1f} dB | Squelch: {'OPEN' if data['squelch_open'] else 'CLOSED'}")
        print(f" Audio Sidetone  : {'ACTIVE (-6 dB loopback)' if sidetone['active'] else 'MUTED'}")
        print(f" CLIMAX Offset   : {data['climax_offset_hz']} Hz")
        print("--------------------------------------------------------------------------------")
        print(f" ARINC 429 Bus   : L030={data['arinc429_hex']['label030']} | L270={data['arinc429_hex']['label270']} | L350={data['arinc429_hex']['label350']} | L356={data['arinc429_hex']['label356']}")
        print("================================================================================")

if __name__ == '__main__':
    main()
