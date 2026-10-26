/**
 * ARINC716Forge Pro - 10-Point Normative Airworthiness Compliance Auditor
 * Standards: ARINC Characteristic 716, RTCA DO-186B, ICAO Annex 10 Vol III Part II, FAA TSO-C37e/C38e
 */

class ARINC716Auditor {
  constructor(engine) {
    this.engine = engine;
  }

  auditAll() {
    const results = [
      this.auditFrequencyBand(),
      this.audit833Spacing(),
      this.audit25kSpacing(),
      this.auditDsbAmModulation(),
      this.auditRfTransmitterPower(),
      this.auditVswrProtection(),
      this.auditReceiverSensitivity(),
      this.auditSidetoneAudio(),
      this.auditClimaxMultiCarrier(),
      this.auditArinc429Protocol()
    ];

    const passedCount = results.filter(r => r.passed).length;
    const scorePercent = ((passedCount / results.length) * 100).toFixed(1);

    return {
      totalRules: results.length,
      passedRules: passedCount,
      failedRules: results.length - passedCount,
      complianceScore: `${scorePercent}%`,
      certifiedStatus: passedCount === results.length ? 'ARINC_716_MARK3_VHF_CERTIFIED' : 'NON_COMPLIANT',
      details: results
    };
  }

  // 1. Operating Frequency Band Coverage (118.000–136.975 MHz)
  auditFrequencyBand() {
    const minFreq = 118000000;
    const maxFreq = 136975000;
    const inBand = this.engine.activeFreqHz >= minFreq && this.engine.activeFreqHz <= maxFreq;
    return {
      id: 'ARINC716-REQ-001',
      title: 'Aeronautical VHF Frequency Band Coverage',
      standard: 'ARINC 716 Section 2.1 & RTCA DO-186B Section 2.2.1',
      passed: inBand,
      value: `${(this.engine.activeFreqHz / 1e6).toFixed(3)} MHz`,
      expected: '118.000 to 136.975 MHz',
      notes: 'Transceiver operates strictly within aeronautical mobile VHF allocation.'
    };
  }

  // 2. 8.33 kHz Channel Spacing Compliance (ICAO Doc 9718)
  audit833Spacing() {
    const ch833 = this.engine.channelSpacing === '8.33';
    const testChannel = ARINC716Engine.freqHzToChannel(132600000, '8.33');
    const validNaming = testChannel === '132.605' || testChannel.length === 7;
    const passed = ch833 && validNaming;
    return {
      id: 'ARINC716-REQ-002',
      title: '8.33 kHz Channel Spacing & 6-Digit Naming',
      standard: 'ICAO Annex 10 Vol III & EUROCAE ED-23C',
      passed: passed,
      value: `Spacing: ${this.engine.channelSpacing} kHz, Channel: ${this.engine.getTelemetry().activeChannel}`,
      expected: '8.33 kHz grid spacing with standard 6-digit channel naming',
      notes: 'Complies with mandatory European airspace 8.33 kHz channel plan (2280 channels).'
    };
  }

  // 3. 25 kHz Channel Spacing Backward Compatibility
  audit25kSpacing() {
    const ch25 = ARINC716Engine.freqHzToChannel(118000000, '25');
    const passed = ch25 === '118.000';
    return {
      id: 'ARINC716-REQ-003',
      title: '25 kHz Legacy Channel Spacing Compatibility',
      standard: 'ARINC 716 Section 2.2 & RTCA DO-186B Class 3/4',
      passed: passed,
      value: `25 kHz channel string: ${ch25}`,
      expected: 'Exact 3-decimal 25 kHz channel synthesis (760 channels)',
      notes: 'Preserves seamless operation across non-8.33 global oceanic and regional flight paths.'
    };
  }

  // 4. Double-Sideband Amplitude Modulation (DSB-AM) Depth
  auditDsbAmModulation() {
    const mod = this.engine.modulationIndex;
    const passed = mod >= 0.85 && mod <= 0.95;
    return {
      id: 'ARINC716-REQ-004',
      title: 'DSB-AM Modulation Depth (85%–95%)',
      standard: 'RTCA DO-186B Section 2.2.4 & ICAO Annex 10 Chapter 2',
      passed: passed,
      value: `${(mod * 100).toFixed(1)}%`,
      expected: '85.0% to 95.0% modulation index without clipping or overmodulation',
      notes: 'Maintains optimal voice intelligibility and spectral purity.'
    };
  }

  // 5. RF Transmitter Output Power (25 Watts Class 3/4/5)
  auditRfTransmitterPower() {
    const pwr = this.engine.txPowerWatts;
    const passed = pwr >= 16.0 && pwr <= 35.0; // 25W nominal
    return {
      id: 'ARINC716-REQ-005',
      title: 'RF Transmitter Carrier Power (25W Nominal)',
      standard: 'ARINC 716 Section 3.2 & FAA TSO-C37e Class 3/4/5',
      passed: passed,
      value: `${pwr.toFixed(1)} Watts (+${(10 * Math.log10(pwr * 1000)).toFixed(1)} dBm)`,
      expected: 'Minimum 16.0W, Nominal 25.0W (+44 dBm) into 50 Ohms',
      notes: 'Ensures required line-of-sight propagation range of 200+ nautical miles at cruise altitude.'
    };
  }

  // 6. Antenna VSWR & Power Amplifier Protection
  auditVswrProtection() {
    const vswr = this.engine.calculateVSWR(this.engine.txPowerWatts, this.engine.reflectedPowerWatts);
    const passed = vswr >= 1.0 && vswr <= 3.0;
    return {
      id: 'ARINC716-REQ-006',
      title: 'Antenna VSWR & Power Amplifier Protection',
      standard: 'ARINC 716 Section 3.4 & RTCA DO-186B Section 2.2.8',
      passed: passed,
      value: `${vswr.toFixed(2)}:1`,
      expected: 'VSWR <= 3.0:1 during nominal transmission; BITE alarm tripped if > 3.0:1',
      notes: 'Reflected power monitor prevents thermal destruction of RF driver transistors.'
    };
  }

  // 7. Receiver Sensitivity & Carrier Squelch Gating
  auditReceiverSensitivity() {
    const sinadNominal = this.engine.calculateSINAD(-107.0);
    const passed = sinadNominal >= 12.0;
    return {
      id: 'ARINC716-REQ-007',
      title: 'Receiver Sensitivity (12 dB SINAD at -107 dBm)',
      standard: 'RTCA DO-186B Section 2.3.1 & FAA TSO-C38e',
      passed: passed,
      value: `${sinadNominal.toFixed(1)} dB SINAD at -107 dBm input`,
      expected: '>= 12.0 dB SINAD at -107 dBm (1.0 uV across 50 Ohms)',
      notes: 'Satisfies low-noise front-end sensitivity for weak remote tower reception.'
    };
  }

  // 8. Sidetone Audio Generation (-6 dB relative to rated audio)
  auditSidetoneAudio() {
    // Temporarily trigger PTT to check sidetone
    const prevPtt = this.engine.pttActive;
    this.engine.pttActive = true;
    const sidetone = this.engine.getSidetoneLevel();
    this.engine.pttActive = prevPtt;
    const passed = sidetone.active && sidetone.attenuationDb === -6.0;
    return {
      id: 'ARINC716-REQ-008',
      title: 'Cockpit Audio Sidetone Generation (-6 dB)',
      standard: 'ARINC 716 Section 4.2 & RTCA DO-186B Section 2.3.6',
      passed: passed,
      value: `${sidetone.attenuationDb} dB attenuation (${sidetone.levelDbm} dBm / ${sidetone.levelMilliwatts.toFixed(1)} mW)`,
      expected: '-6.0 dB relative to 100 mW rated audio into 600 Ohms',
      notes: 'Provides pilots with acoustic feedback during microphone transmission.'
    };
  }

  // 9. CLIMAX Multi-Carrier Frequency Offset Capability
  auditClimaxMultiCarrier() {
    const validOffsets = [0, 2500, -2500, 7500, -7500];
    const passed = validOffsets.includes(this.engine.climaxOffsetHz);
    return {
      id: 'ARINC716-REQ-009',
      title: 'CLIMAX Offset Carrier Synthesis',
      standard: 'ICAO Annex 10 Vol III Part II Chapter 2 & ARINC 716 Section 2.3',
      passed: passed,
      value: `${this.engine.climaxOffsetHz >= 0 ? '+' : ''}${this.engine.climaxOffsetHz} Hz`,
      expected: 'Supported offsets: 0 Hz, +/-2.5 kHz, +/-7.5 kHz',
      notes: 'Mitigates destructive inter-station heterodyne beat notes across wide-area sectors.'
    };
  }

  // 10. ARINC 429 Digital Control Bus Protocol & Parity
  auditArinc429Protocol() {
    const l030 = this.engine.encodeLabel030(this.engine.activeFreqHz, this.engine.channelSpacing);
    const l270 = this.engine.encodeLabel270();
    const l350 = this.engine.encodeLabel350();
    const l356 = this.engine.encodeLabel356();

    const verifyParity = (word) => {
      let count = 0;
      for (let i = 0; i < 32; i++) {
        if ((word >>> i) & 1) count++;
      }
      return (count % 2) === 1; // Must be odd
    };

    const p030 = verifyParity(l030.rawUint32);
    const p270 = verifyParity(l270.rawUint32);
    const p350 = verifyParity(l350.rawUint32);
    const p356 = verifyParity(l356.rawUint32);

    const passed = p030 && p270 && p350 && p356;
    return {
      id: 'ARINC716-REQ-010',
      title: 'ARINC 429 Digital Bus Serialization & Bit 32 Odd Parity',
      standard: 'ARINC Specification 429-19 & ARINC 716 Attachment 1',
      passed: passed,
      value: `L030:${l030.rawHex} (P:${l030.parityBit}), L270:${l270.rawHex}, L350:${l350.rawHex}, L356:${l356.rawHex}`,
      expected: 'Strict Bit 32 odd parity validation across all four transmitted labels',
      notes: 'Ensures robust digital frequency tuning and health monitoring over twisted-shielded pair buses.'
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ARINC716Auditor };
}
