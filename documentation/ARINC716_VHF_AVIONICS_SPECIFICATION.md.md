# ARINC Characteristic 716 Mark 3 VHF Communications Transceiver Specification

## 1\. Scope & System Definition

ARINC Characteristic 716 defines the standard form, fit, and operational functions of the airborne Very High Frequency (VHF) communications transceiver system. Installed on all commercial air transport aircraft (Airbus A320/A350/A380, Boeing 737/777/787, Embraer E-Jets), the system provides short-to-medium-range line-of-sight voice and data communications between aircraft and Air Traffic Control (ATC) or Airline Operational Control (AOC).

## 2\. RF Transmission Characteristics

- **Operating Frequency Band**: 118.000 MHz to 136.975 MHz.  
- **Channel Spacing**:  
  - 8.33 kHz channel spacing (ICAO Doc 9718 & European EUR region mandate, 2280 total channels).  
  - 25.0 kHz legacy channel spacing (760 total channels).  
- **Modulation**: Double-Sideband Amplitude Modulation (DSB-AM, emission designator 6K00A3E for 25 kHz, 5K00A3E for 8.33 kHz).  
- **Modulation Depth**: 85% to 95% nominal depth with voice audio inputs.  
- **Transmitter Output Power**: 25.0 Watts nominal (+44 dBm) into a 50-ohm load (Class 3/4/5 per RTCA DO-186B).  
- **Antenna VSWR Monitoring**:  
  - Voltage Standing Wave Ratio evaluated via internal forward and reflected directional couplers: \$\$\\Gamma \= \\sqrt{\\frac{P\_{refl}}{P\_{fwd}}}, \\quad \\text{VSWR} \= \\frac{1 \+ \\Gamma}{1 \- \\Gamma}\$\$  
  - A threshold trip occurs at \$\\text{VSWR} \> 3.0:1\$, activating the High VSWR warning flag on ARINC 429 Label 350 Bit 15\.

## 3\. Receiver & Squelch Performance

- **Sensitivity**: Receiver produces \$\\ge 12.0\\text{ dB}\$ SINAD for an RF input signal of \$-107.0\\text{ dBm}\$ (\$1.0\\ \\mu\\text{V}\$ across \$50\\ \\Omega\$).  
- **Carrier/Noise Squelch**: Opens reliably when receiver SINAD \$\\ge 10.0\\text{ dB}\$; provides cockpit manual squelch defeat mode.  
- **Sidetone Audio**: Provides \$-6.0\\text{ dB}\$ audio loopback feedback relative to rated audio output (100 mW into \$600\\ \\Omega\$) during PTT transmission.  
- **CLIMAX Offset Carrier**: Supports wide-area offset carrier operations: 0 Hz, \$\\pm 2.5\\text{ kHz}\$, \$\\pm 7.5\\text{ kHz}\$.

## 4\. Digital ARINC 429 Bus Interface

All digital control and health monitoring occurs over ARINC 429 low/high-speed twisted shielded pair buses:

- **Label 030**: VHF Comm Frequency Tuning Word (BCD representation).  
- **Label 270**: Discrete Mode & Control Word (PTT state, squelch defeat, 8.33 kHz select, voice/data mode).  
- **Label 350**: SDU / VHF Transceiver BITE Fault Word (Synthesizer unlock, PA over-temp, high VSWR, power supply).  
- **Label 356**: Frequency Tuning Acknowledgement & Readback Word.  
- **Parity**: Strict Bit 32 odd parity enforced on all transmissions.