/**
 * ARINC716Forge Pro - Core Avionics VHF Transceiver Engine
 * Standards: ARINC Characteristic 716 (Mark 3 VHF), RTCA DO-186B, ICAO Annex 10 Vol III Part II
 * 
 * Provides:
 * - 8.33 kHz (2280 channels) and 25 kHz (760 channels) channel plan & frequency synthesis
 * - DSB-AM modulation and carrier power modeling (25W Class 3/4/5)
 * - RF forward/reflected power & VSWR calculations
 * - Receiver sensitivity (12 dB SINAD at -107 dBm) & carrier/noise squelch gating
 * - CLIMAX multi-carrier offset synthesis (0 Hz, ±2.5 kHz, ±7.5 kHz)
 * - Sidetone audio loopback (-6 dB) & PTT state machine
 * - ARINC 429 digital bus serialization (Labels 030, 270, 350, 356) with Bit 32 odd parity
 */

class ARINC716Engine {
  constructor(options = {}) {
    this.unitId = options.unitId || 1; // 1=VHF1, 2=VHF2, 3=VHF3
    this.activeFreqHz = options.activeFreqHz || 118000000; // 118.000 MHz
    this.standbyFreqHz = options.standbyFreqHz || 121500000; // 121.500 MHz (Guard)
    this.channelSpacing = options.channelSpacing || '8.33'; // '8.33' or '25'
    this.txPowerWatts = options.txPowerWatts || 25.0; // 25W nominal
    this.reflectedPowerWatts = options.reflectedPowerWatts || 0.8; // ~1.37:1 VSWR normal
    this.modulationIndex = options.modulationIndex || 0.90; // 90% AM modulation
    this.pttActive = false;
    this.squelchDefeat = false;
    this.squelchThresholdSinad = 10.0; // dB SINAD
    this.rxInputPowerDbm = -95.0; // dBm incoming signal
    this.rxNoiseFloorDbm = -115.0; // dBm thermal noise
    this.climaxOffsetHz = 0; // 0, +2500, -2500, +7500, -7500 Hz
    this.voiceMode = true; // true=Voice, false=Data (VDL)
    this.guardReceiverActive = true; // Dedicated 121.5 MHz guard receiver
    
    // BITE Fault status flags
    this.faults = {
      synthesizerUnlock: false,
      paOverTemp: false,
      powerSupplyFault: false,
      antennaDisconnect: false,
      vswrHigh: false,
      sidetoneFault: false
    };

    // Predefined preset frequencies
    this.presets = {
      'EMERGENCY_GUARD': 121500000,
      'LONDON_CONTROL': 132605000, // 8.33 kHz channel 132.605
      'DUBAI_APPROACH': 124900000, // 124.900 MHz
      'NEW_YORK_CENTER': 128300000, // 128.300 MHz
      'PARIS_ACC': 126105000       // 8.33 kHz channel 126.105
    };
  }

  // --- Frequency & Channel Conversion Utilities ---

  /**
   * Converts frequency in Hz to standard 8.33 kHz or 25 kHz channel string.
   * ICAO Doc 9718 Channel naming rules:
   * 118.000 MHz (25 kHz) -> "118.000"
   * 118.000 MHz (8.33 kHz) -> "118.005"
   * 118.00833 MHz -> "118.010"
   * 118.01667 MHz -> "118.015"
   * 118.025 MHz (25 kHz) -> "118.025"
   * 118.025 MHz (8.33 kHz) -> "118.030"
   * 118.03333 MHz -> "118.035"
   * 118.04167 MHz -> "118.040"
   * 118.050 MHz (25 kHz) -> "118.050"
   */
  static freqHzToChannel(freqHz, spacing = '8.33') {
    const mhz = freqHz / 1e6;
    if (spacing === '25') {
      return mhz.toFixed(3);
    }
    // 8.33 kHz channel spacing
    const baseMhz = Math.floor(mhz);
    const remainderKhz = Math.round((mhz - baseMhz) * 1000);
    // Find closest 25 kHz block
    const block25 = Math.floor(remainderKhz / 25) * 25;
    const offsetInBlock = remainderKhz - block25;

    let channelSuffix = 0;
    if (offsetInBlock < 4) {
      // 0.00 kHz offset -> .xx5
      channelSuffix = block25 + 5;
    } else if (offsetInBlock >= 4 && offsetInBlock < 12) {
      // 8.33 kHz offset -> .xx0
      channelSuffix = block25 + 10;
    } else if (offsetInBlock >= 12 && offsetInBlock < 21) {
      // 16.67 kHz offset -> .xx5
      channelSuffix = block25 + 15;
    } else {
      // 25.0 kHz offset -> .xx0
      channelSuffix = block25 + 30;
    }
    
    const formattedSuffix = channelSuffix.toString().padStart(3, '0');
    return `${baseMhz}.${formattedSuffix}`;
  }

  /**
   * Converts 8.33 kHz or 25 kHz channel string back to true RF carrier Hz
   */
  static channelToFreqHz(channelStr) {
    const parts = channelStr.split('.');
    const mhz = parseInt(parts[0], 10);
    const suffix = parseInt(parts[1], 10);
    
    // Check if it matches an 8.33 channel
    const rem = suffix % 100;
    const baseKhz = Math.floor(suffix / 100) * 100;

    // Standard ICAO 25 kHz / 8.33 kHz table
    const offsetMap = {
      0: 0,
      5: 0,
      10: 8333.33,
      15: 16666.67,
      25: 25000,
      30: 25000,
      35: 33333.33,
      40: 41666.67,
      50: 50000,
      55: 50000,
      60: 58333.33,
      65: 66666.67,
      75: 75000,
      80: 75000,
      85: 83333.33,
      90: 91666.67
    };

    let offset = 0;
    if (offsetMap[rem] !== undefined) {
      offset = offsetMap[rem];
    } else {
      offset = rem * 1000;
    }

    return Math.round((mhz * 1e6) + (baseKhz * 1000) + offset);
  }

  // --- RF Math & Parameter Evaluation ---

  /**
   * Calculates Voltage Standing Wave Ratio (VSWR) from forward & reflected power:
   * Gamma = sqrt(Pr / Pf)
   * VSWR = (1 + Gamma) / (1 - Gamma)
   */
  calculateVSWR(forwardWatts, reflectedWatts) {
    if (forwardWatts <= 0) return 1.0;
    if (reflectedWatts < 0) reflectedWatts = 0;
    if (reflectedWatts >= forwardWatts) return 99.9;
    const gamma = Math.sqrt(reflectedWatts / forwardWatts);
    if (gamma >= 0.99) return 99.9;
    const vswr = (1 + gamma) / (1 - gamma);
    return parseFloat(vswr.toFixed(2));
  }

  /**
   * Calculates Receiver SINAD (Signal-to-Noise-and-Distortion) in dB
   * based on RF input power (dBm), noise floor (-115 dBm), and 30% AM modulation.
   */
  calculateSINAD(inputDbm) {
    // Nominal sensitivity: -107 dBm yields 12.0 dB SINAD
    // Slope roughly 1 dB SINAD per 1 dBm above thermal floor up to saturation (approx 40 dB SINAD max)
    if (inputDbm <= -120) return 0.0;
    const sinad = 12.0 + (inputDbm - (-107.0));
    return Math.max(0.0, Math.min(42.0, parseFloat(sinad.toFixed(1))));
  }

  /**
   * Squelch state determination: true if audio gate opens
   */
  isSquelchOpen() {
    if (this.squelchDefeat) return true;
    const sinad = this.calculateSINAD(this.rxInputPowerDbm);
    return sinad >= this.squelchThresholdSinad;
  }

  /**
   * Computes cockpit sidetone audio level in dBm and mW
   * Standard: -6 dB relative to rated audio (100 mW into 600 ohms = +20 dBm -> Sidetone is +14 dBm / 25 mW)
   */
  getSidetoneLevel() {
    if (!this.pttActive) return { active: false, levelDbm: -Infinity, levelMilliwatts: 0 };
    if (this.faults.sidetoneFault) return { active: false, levelDbm: -Infinity, levelMilliwatts: 0 };
    return {
      active: true,
      levelDbm: 14.0, // +14 dBm
      levelMilliwatts: 25.12,
      attenuationDb: -6.0
    };
  }

  /**
   * Swaps Active and Standby frequencies (Transfer button)
   */
  transferFrequencies() {
    const temp = this.activeFreqHz;
    this.activeFreqHz = this.standbyFreqHz;
    this.standbyFreqHz = temp;
    return {
      activeFreqHz: this.activeFreqHz,
      activeChannel: ARINC716Engine.freqHzToChannel(this.activeFreqHz, this.channelSpacing),
      standbyFreqHz: this.standbyFreqHz,
      standbyChannel: ARINC716Engine.freqHzToChannel(this.standbyFreqHz, this.channelSpacing)
    };
  }

  // --- ARINC 429 Bus Protocol Serialization ---

  /**
   * Computes Bit 32 Odd Parity for 32-bit ARINC 429 word
   */
  static computeOddParity(val31) {
    let count = 0;
    for (let i = 0; i < 31; i++) {
      if ((val31 >>> i) & 1) count++;
    }
    return (count % 2 === 0) ? 1 : 0; // 1 if even count to make total odd
  }

  /**
   * Encodes ARINC 429 Label 030: VHF Comm Frequency Tuning Word (BCD)
   * Bits 1-8: Label 030 (Octal 030 = 0x18)
   * Bits 9-10: SDI (00=VHF1, 01=VHF1, 10=VHF2, 11=VHF3)
   * Bits 11-28: BCD frequency encoding
   * Bit 29: 8.33 kHz spacing flag (1=8.33, 0=25 kHz)
   * Bits 30-31: SSM (11 = Normal Operation)
   * Bit 32: Odd Parity
   */
  encodeLabel030(freqHz, spacing = '8.33') {
    const mhz = freqHz / 1e6;
    const baseMhz = Math.floor(mhz);
    const fracKhz = Math.round((mhz - baseMhz) * 1000);

    const mhzUnits = baseMhz % 10;
    const mhzTens = Math.floor((baseMhz % 100) / 10);
    const mhzHundreds = Math.floor(baseMhz / 100);

    const khzHundreds = Math.floor(fracKhz / 100);
    const khzTens = Math.floor((fracKhz % 100) / 10);
    const khzUnits = fracKhz % 10;

    let word = 0x18; // Label 030 octal = 0x18
    const sdi = (this.unitId & 0x03);
    word |= (sdi << 8);

    // BCD packing:
    // Bits 11-14: 100 kHz digit
    // Bits 15-18: 10 kHz digit
    // Bits 19-22: 1 MHz digit
    // Bits 23-26: 10 MHz digit
    // Bits 27-28: 100 MHz digit (always 1 for 118-136 MHz)
    word |= ((khzHundreds & 0x0F) << 10);
    word |= ((khzTens & 0x0F) << 14);
    word |= ((mhzUnits & 0x0F) << 18);
    word |= ((mhzTens & 0x0F) << 22);
    word |= ((mhzHundreds & 0x03) << 26);

    // Bit 29: 8.33 kHz selection indicator
    if (spacing === '8.33') {
      word |= (1 << 28);
    }

    // Bits 30-31: SSM (11 = Normal Operation)
    word |= (0x03 << 29);

    // Bit 32: Odd Parity
    const parity = ARINC716Engine.computeOddParity(word);
    word |= (parity << 31);

    return {
      label: '030',
      labelOctal: '030',
      description: 'VHF Comm Frequency Tuning Word',
      rawHex: '0x' + (word >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      rawUint32: word >>> 0,
      parityBit: parity,
      ssm: 'Normal Operation (11)',
      tunedMhz: mhz.toFixed(4)
    };
  }

  /**
   * Encodes ARINC 429 Label 270: Discrete Control / Mode Status Word
   */
  encodeLabel270() {
    let word = 0x58; // Label 270 octal (0270 -> reversed octal label 0x58)
    const sdi = (this.unitId & 0x03);
    word |= (sdi << 8);

    // Bit 11: PTT Active
    if (this.pttActive) word |= (1 << 10);
    // Bit 12: Squelch Defeat
    if (this.squelchDefeat) word |= (1 << 11);
    // Bit 13: 8.33 kHz mode active
    if (this.channelSpacing === '8.33') word |= (1 << 12);
    // Bit 14: CLIMAX offset active
    if (this.climaxOffsetHz !== 0) word |= (1 << 13);
    // Bit 15: Voice mode (1) / Data mode (0)
    if (this.voiceMode) word |= (1 << 14);
    // Bit 16: Guard receiver active
    if (this.guardReceiverActive) word |= (1 << 15);

    // SSM: Normal Operation (11)
    word |= (0x03 << 29);

    const parity = ARINC716Engine.computeOddParity(word);
    word |= (parity << 31);

    return {
      label: '270',
      labelOctal: '270',
      description: 'VHF Transceiver Discrete Mode & Control Word',
      rawHex: '0x' + (word >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      rawUint32: word >>> 0,
      parityBit: parity,
      ptt: this.pttActive,
      squelchDefeat: this.squelchDefeat,
      channelSpacing: this.channelSpacing
    };
  }

  /**
   * Encodes ARINC 429 Label 350: SDU / VHF Transceiver BITE & Fault Word
   */
  encodeLabel350() {
    let word = 0xE8; // Label 350 octal = 0xE8
    const sdi = (this.unitId & 0x03);
    word |= (sdi << 8);

    // Check high VSWR threshold (> 3.0:1)
    const vswr = this.calculateVSWR(this.txPowerWatts, this.reflectedPowerWatts);
    const vswrAlarm = vswr > 3.0 || this.faults.vswrHigh;

    if (this.faults.synthesizerUnlock) word |= (1 << 10); // Bit 11
    if (this.faults.paOverTemp) word |= (1 << 11); // Bit 12
    if (this.faults.powerSupplyFault) word |= (1 << 12); // Bit 13
    if (this.faults.antennaDisconnect) word |= (1 << 13); // Bit 14
    if (vswrAlarm) word |= (1 << 14); // Bit 15: High VSWR
    if (this.faults.sidetoneFault) word |= (1 << 15); // Bit 16

    // If any fault active, SSM = Failure Warning (00), else Normal Operation (11)
    const hasFault = this.faults.synthesizerUnlock || this.faults.paOverTemp || 
                     this.faults.powerSupplyFault || this.faults.antennaDisconnect || 
                     vswrAlarm || this.faults.sidetoneFault;
    const ssm = hasFault ? 0x00 : 0x03;
    word |= (ssm << 29);

    const parity = ARINC716Engine.computeOddParity(word);
    word |= (parity << 31);

    return {
      label: '350',
      labelOctal: '350',
      description: 'VHF Transceiver BITE / Fault Status Word',
      rawHex: '0x' + (word >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      rawUint32: word >>> 0,
      parityBit: parity,
      hasFault: hasFault,
      ssmStatus: hasFault ? 'Failure Warning (00)' : 'Normal Operation (11)',
      vswrValue: vswr
    };
  }

  /**
   * Encodes ARINC 429 Label 356: Frequency Tuning Acknowledgement / Readback Word
   */
  encodeLabel356() {
    const label030 = this.encodeLabel030(this.activeFreqHz, this.channelSpacing);
    // Label 356 has octal label 356 (0xEE)
    let word = (label030.rawUint32 & 0xFFFFFF00) | 0xEE;
    // Strip old parity bit 32
    word &= 0x7FFFFFFF;
    const parity = ARINC716Engine.computeOddParity(word);
    word |= (parity << 31);

    return {
      label: '356',
      labelOctal: '356',
      description: 'Frequency Tuning Readback Word',
      rawHex: '0x' + (word >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      rawUint32: word >>> 0,
      parityBit: parity
    };
  }

  /**
   * Returns complete telemetry snapshot
   */
  getTelemetry() {
    const vswr = this.calculateVSWR(this.txPowerWatts, this.reflectedPowerWatts);
    const sinad = this.calculateSINAD(this.rxInputPowerDbm);
    const squelchOpen = this.isSquelchOpen();
    const sidetone = this.getSidetoneLevel();

    return {
      unitId: `VHF ${this.unitId}`,
      activeChannel: ARINC716Engine.freqHzToChannel(this.activeFreqHz, this.channelSpacing),
      activeFreqHz: this.activeFreqHz,
      activeFreqMhz: (this.activeFreqHz / 1e6).toFixed(4),
      standbyChannel: ARINC716Engine.freqHzToChannel(this.standbyFreqHz, this.channelSpacing),
      standbyFreqHz: this.standbyFreqHz,
      standbyFreqMhz: (this.standbyFreqHz / 1e6).toFixed(4),
      channelSpacing: `${this.channelSpacing} kHz`,
      pttActive: this.pttActive,
      txCarrierPowerWatts: this.pttActive ? this.txPowerWatts : 0.0,
      txCarrierPowerDbm: this.pttActive ? (10 * Math.log10(this.txPowerWatts * 1000)).toFixed(1) : '-Inf',
      reflectedPowerWatts: this.pttActive ? this.reflectedPowerWatts : 0.0,
      vswr: vswr,
      vswrStatus: vswr <= 1.5 ? 'EXCELLENT' : vswr <= 2.5 ? 'ACCEPTABLE' : 'HIGH_VSWR_ALARM',
      amModulationPercent: (this.modulationIndex * 100).toFixed(0) + '%',
      rxInputPowerDbm: this.rxInputPowerDbm,
      rxSinadDb: sinad,
      squelchOpen: squelchOpen,
      squelchThresholdDb: this.squelchThresholdSinad,
      sidetoneAudio: sidetone,
      climaxOffsetHz: this.climaxOffsetHz,
      arinc429: {
        label030: this.encodeLabel030(this.activeFreqHz, this.channelSpacing),
        label270: this.encodeLabel270(),
        label350: this.encodeLabel350(),
        label356: this.encodeLabel356()
      }
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ARINC716Engine };
}
