import { describe, expect, it } from 'vitest'
import { decodeIwSsid, iwScanLoopScript, parseIwScan } from '../src/main/platform/iw'

// Documented format, NOT live-verified: assembled from iw's own scan.c print statements and public
// real dumps, with the values modelled on the access points in the real beacon captures so the two
// decoders can be compared. Replace with a real `iw dev <if> scan dump` from a Linux box with a
// Wi-Fi card as soon as one exists (docs/WIFI-FINDINGS.md says which claims depend on it).
const IW_SCAN_DUMP = `BSS 84:78:48:1c:dd:37(on wlp2s0) -- associated
	last seen: 2583.123s [boottime]
	TSF: 1234567890 usec (0d, 00:20:34)
	freq: 5640
	beacon interval: 100 TUs
	capability: ESS Privacy SpectrumMgmt ShortSlotTime RadioMeasure (0x1511)
	signal: -59.00 dBm
	last seen: 120 ms ago
	Information elements from Probe Response frame:
	SSID: tardis_nomap
	Supported rates: 6.0* 9.0 12.0* 18.0 24.0* 36.0 48.0 54.0 
	Country: SE	Environment: Indoor/Outdoor
		Channels [100 - 144] @ 23 dBm
	Power constraint: 0 dB
	BSS Load:
		 * station count: 0
		 * channel utilisation: 0/255
		 * available admission capacity: 0 [*32us]
	HT capabilities:
		Capabilities: 0x9ef
			RX LDPC
			HT20/HT40
		Maximum RX AMPDU length 65535 bytes (exponent: 0x003)
		Minimum RX AMPDU time spacing: 4 usec (0x05)
		HT RX MCS rate indexes supported: 0-31
		HT TX MCS rate indexes are undefined
	HT operation:
		 * primary channel: 128
		 * secondary channel offset: below
		 * STA channel width: any
	VHT capabilities:
		VHT Capabilities (0x338b89b2):
			Max MPDU length: 11454
			Supported Channel Width: 160 MHz
		VHT RX MCS set:
			1 streams: MCS 0-9
			2 streams: MCS 0-9
			3 streams: MCS 0-9
			4 streams: MCS 0-9
			5 streams: not supported
			6 streams: not supported
			7 streams: not supported
			8 streams: not supported
		VHT RX highest supported: 0 Mbps
	VHT operation:
		 * channel width: 1 (80 MHz)
		 * center freq segment 1: 122
		 * center freq segment 2: 114
		 * VHT basic MCS set: 0xfffc
	RSN:	 * Version: 1
		 * Group cipher: CCMP
		 * Pairwise ciphers: CCMP
		 * Authentication suites: SAE
		 * Capabilities: 16-PTKSA-RC 1-GTKSA-RC MFP-required (0x00cc)
	HE capabilities:
		HE MAC Capabilities (0x0d01181a4010):
			+HTC HE Supported
		HE RX MCS and NSS set <= 80 MHz
			1 streams: MCS 0-11
			2 streams: MCS 0-11
			3 streams: MCS 0-11
			4 streams: MCS 0-11
			5 streams: not supported
	HE Operation:
		 * BSS Color: 13
	EHT capabilities:
		EHT MAC Capabilities (0x1104):
	WMM:	 * Parameter version 1
		 * u-APSD
		 * BE: CW 15-1023, AIFSN 3
	Vendor specific: OUI 00:15:6d, data: 01 55 37 50 72 6f 58 47 53
	Vendor specific: OUI 8c:fd:f0, data: 01 01 02 01 00 02 01 01 03 03
BSS 8a:78:48:1c:dd:38(on wlp2s0)
	TSF: 1234567890 usec (0d, 00:20:34)
	freq: 2412
	beacon interval: 100 TUs
	capability: ESS Privacy ShortPreamble ShortSlotTime RadioMeasure (0x1431)
	signal: -56.00 dBm
	last seen: 980 ms ago
	SSID: tdc_nomap
	Supported rates: 1.0* 2.0* 5.5* 11.0* 6.0 9.0 12.0 18.0 
	DS Parameter set: channel 1
	Country: SE	Environment: Indoor/Outdoor
		Channels [1 - 13] @ 20 dBm
	BSS Load:
		 * station count: 11
		 * channel utilisation: 77/255
		 * available admission capacity: 0 [*32us]
	HT capabilities:
		Capabilities: 0x9ad
		HT RX MCS rate indexes supported: 0-15
	HT operation:
		 * primary channel: 1
		 * secondary channel offset: no secondary
		 * STA channel width: 20 MHz
	RSN:	 * Version: 1
		 * Group cipher: CCMP
		 * Pairwise ciphers: CCMP
		 * Authentication suites: PSK
		 * Capabilities: 16-PTKSA-RC 1-GTKSA-RC MFP-capable (0x008c)
	HE capabilities:
		HE MAC Capabilities (0x0d01181a4010):
	EHT capabilities:
		EHT MAC Capabilities (0x1104):
	Vendor specific: OUI 00:15:6d, data: 00 01 01 00 01 02 a4 a6
BSS 38:a6:59:94:20:3e(on wlp2s0)
	TSF: 55 usec (0d, 00:00:00)
	freq: 2437.0
	beacon interval: 100 TUs
	capability: ESS Privacy ShortSlotTime (0x0411)
	signal: -83.00 dBm
	last seen: 25400 ms ago
	SSID: #Telia-942038
	HT capabilities:
		Capabilities: 0x11ef
		HT RX MCS rate indexes supported: 0-15, 32
	HT operation:
		 * primary channel: 6
		 * secondary channel offset: above
		 * STA channel width: any
	RSN:	 * Version: 1
		 * Group cipher: CCMP
		 * Pairwise ciphers: CCMP
		 * Authentication suites: PSK SAE
	WPS:	 * Version: 1.0
		 * Wi-Fi Protected Setup State: 2 (Configured)
		 * Response Type: 3 (AP)
		 * UUID: 12345678-1234-1234-1234-123456789abc
		 * Manufacturer: TP-Link
		 * Model: Archer C7
		 * Model Number: 2.0
		 * Device name: Archer C7
		 * Config methods: Label, Display, PBC
	Unknown IE (255): 23 0d 01 18 1a 40 10 0c 63 40 88 ff 49 81 1c 11 08 00 fa ff fa ff
BSS e6:38:83:e8:42:7f(on wlp2s0)
	freq: 6135
	capability: ESS Privacy (0x0011)
	signal: -62.00 dBm
	last seen: 300 ms ago
	SSID: wifi6e-control
	RSN:	 * Version: 1
		 * Group cipher: GCMP-256
		 * Pairwise ciphers: GCMP-256
		 * Authentication suites: IEEE 802.1X/SUITE-B-192
	HE capabilities:
		HE MAC Capabilities (0x0d01181a4010):
		HE RX MCS and NSS set <= 80 MHz
			1 streams: MCS 0-11
			2 streams: MCS 0-11
			3 streams: not supported
BSS 02:11:22:33:44:55(on wlp2s0)
	freq: 5180
	capability: ESS (0x0001)
	signal: -70.00 dBm
	last seen: 50 ms ago
	SSID: \\x00\\x00\\x00\\x00
BSS 00:aa:bb:cc:dd:ee(on wlp2s0)
	freq: 2462
	capability: ESS Privacy (0x0011)
	signal: -71.00 dBm
	SSID: Caf\\xc3\\xa9 legacy
	WPA:	 * Version: 1
		 * Group cipher: TKIP
		 * Pairwise ciphers: TKIP
		 * Authentication suites: PSK
BSS 00:aa:bb:cc:dd:ef(on wlp2s0)
	freq: 2462
	capability: ESS Privacy (0x0011)
	signal: 70/100
	SSID: wep-only
`

describe('parseIwScan', () => {
  const all = parseIwScan(IW_SCAN_DUMP)
  const by = (bssid: string) => all.find((b) => b.bssid === bssid)!

  it('finds every BSS block and keeps the association flag', () => {
    expect(all.map((b) => b.bssid)).toEqual([
      '84:78:48:1c:dd:37',
      '8a:78:48:1c:dd:38',
      '38:a6:59:94:20:3e',
      'e6:38:83:e8:42:7f',
      '02:11:22:33:44:55',
      '00:aa:bb:cc:dd:ee',
      '00:aa:bb:cc:dd:ef'
    ])
    expect(by('84:78:48:1c:dd:37').associated).toBe(true)
    expect(by('8a:78:48:1c:dd:38').associated).toBe(false)
  })

  it('reads a 4x4 Wi-Fi 7 access point the same way the beacon decoder does', () => {
    const b = by('84:78:48:1c:dd:37')
    expect(b.ssid).toBe('tardis_nomap')
    expect(b.freqMhz).toBe(5640)
    expect(b.rssi).toBe(-59)
    expect(b.ageMs).toBe(120)
    expect(b.facts.phy).toBe('802.11be')
    expect(b.facts.streams).toBe(4)
    expect(b.facts.clients).toBe(0)
    expect(b.facts.utilizationPct).toBe(0)
    expect(b.facts.security).toBe('WPA3-Personal')
    expect(b.facts.countryCode).toBe('SE')
    // iw labels width 1 "(80 MHz)" whatever the segments say; 122 and 114 are eight apart.
    expect(b.facts.widthMhz).toBe(160)
    expect(b.facts.vendorOuis).toEqual(['00156d', '8cfdf0'])
  })

  it('reads a busy 2.4 GHz channel: station count, utilisation out of 255, WPA2, 20 MHz', () => {
    const b = by('8a:78:48:1c:dd:38')
    expect(b.freqMhz).toBe(2412)
    expect(b.facts.clients).toBe(11)
    expect(b.facts.utilizationPct).toBe(30)
    expect(b.facts.security).toBe('WPA2-Personal')
    expect(b.facts.streams).toBe(2)
    expect(b.facts.widthMhz).toBe(20)
  })

  it('takes the decimal freq form, the first MCS range, WPS names and HE as an unknown element', () => {
    const b = by('38:a6:59:94:20:3e')
    expect(b.freqMhz).toBe(2437)
    expect(b.ageMs).toBe(25400)
    expect(b.facts.streams).toBe(2)
    expect(b.facts.widthMhz).toBe(40)
    expect(b.facts.security).toBe('WPA2/WPA3-Personal')
    expect(b.facts.manufacturer).toBe('TP-Link')
    // "Model Number" must not be mistaken for the model.
    expect(b.facts.model).toBe('Archer C7')
    // An iw too old to decode HE prints it as extension element 0x23.
    expect(b.facts.phy).toBe('802.11ax')
  })

  it('reads a 6 GHz access point with only HE elements and an enterprise suite', () => {
    const b = by('e6:38:83:e8:42:7f')
    expect(b.freqMhz).toBe(6135)
    expect(b.facts.phy).toBe('802.11ax')
    expect(b.facts.streams).toBe(2)
    expect(b.facts.security).toBe('WPA2/WPA3-Enterprise')
    expect(b.facts.widthMhz).toBeUndefined()
  })

  it('treats a NUL-only SSID as hidden and an ESS without Privacy as open', () => {
    const b = by('02:11:22:33:44:55')
    expect(b.ssid).toBe('')
    expect(b.facts.security).toBeUndefined()
    expect(b.facts.phy).toBeUndefined()
  })

  it('decodes escaped UTF-8 in a name and calls the old WPA element WPA', () => {
    const b = by('00:aa:bb:cc:dd:ee')
    expect(b.ssid).toBe('Café legacy')
    expect(b.facts.security).toBe('WPA')
    expect(b.ageMs).toBeUndefined()
  })

  it('leaves the signal unknown when a driver reports it in unspecified units, and names WEP', () => {
    const b = by('00:aa:bb:cc:dd:ef')
    expect(b.rssi).toBeUndefined()
    expect(b.facts.security).toBe('WEP')
  })

  it('returns nothing for an error message or an empty dump instead of throwing', () => {
    expect(parseIwScan('command failed: Operation not permitted (-1)\n')).toEqual([])
    expect(parseIwScan('')).toEqual([])
  })
})

describe('decodeIwSsid', () => {
  it('unescapes bytes and strips trailing NULs', () => {
    expect(decodeIwSsid(' plain')).toBe('plain')
    expect(decodeIwSsid(' a\\x20b')).toBe('a b')
    expect(decodeIwSsid(' \\x00\\x00')).toBe('')
  })
})

describe('iwScanLoopScript', () => {
  const script = iwScanLoopScript('wlan0', '/tmp/out.txt', '/tmp/out.stop', '/tmp/out.keep')

  it('scans into a temporary file and renames it, so a reader never sees half a dump', () => {
    expect(script).toContain(
      "iw dev 'wlan0' scan > '/tmp/out.txt.tmp' 2>&1; mv -f '/tmp/out.txt.tmp' '/tmp/out.txt'"
    )
  })

  it('stops on the stop file, the hard cap, or five idle minutes', () => {
    expect(script).toContain("[ ! -f '/tmp/out.stop' ]")
    expect(script).toContain('$n -lt 3600')
    expect(script).toContain("find '/tmp/out.keep' -mmin -5")
    expect(script.endsWith("rm -f '/tmp/out.stop'; true")).toBe(true)
  })

  it('quotes every value it was handed', () => {
    expect(iwScanLoopScript("wl'an", '/tmp/o', '/tmp/s', '/tmp/k')).toContain(
      "iw dev 'wl'\\''an' scan"
    )
  })
})
