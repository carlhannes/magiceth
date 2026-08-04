# VLAN findings

What `magiceth` claims about VLANs, and what the hardware actually does. Everything below was
measured on 2026-08-04; commands and their raw output are quoted verbatim so the conclusions can be
re-checked rather than taken on trust.

This file owns the VLAN topic. [SUDO-TEST.md](../SUDO-TEST.md) links here instead of repeating it.

## The rig

|        |                                                                              |
| ------ | ---------------------------------------------------------------------------- |
| Host   | macOS 26.6 (build 25G72), arm64                                              |
| `en9`  | ASIX AX88179A, USB `0b95:1790`, MAC `6c:6e:07:01:ff:de`                      |
| `en7`  | Realtek RTL8153, USB `0bda:8153`, MAC `00:e0:4c:be:53:2c`                    |
| Switch | One **unmanaged** Zyxel, both dongles plugged into it, nothing else attached |

An unmanaged switch never originates LLDP or CDP, so the `C` feature could only ever demonstrate its
"none heard" path here. LLDP frames were therefore generated deliberately: a hand-built 802.1AB
frame written straight to `/dev/bpf` on `en9`, so `en7` could hear it across the switch.

## Verdicts

| Claim                                             | Verdict                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `chipsets.json` says `vlan: true` for `0b95:1790` | **Confirmed** — tagged frames pass in both directions                                                                    |
| `chipsets.json` says `vlan: true` for `0bda:8153` | **Confirmed** — same                                                                                                     |
| `parseDiscovery` handles real `tcpdump -v` output | **Confirmed**, though the real format differs from the fixture it was written against                                    |
| Pressing `C` reports a switch neighbour           | **Was broken** — reported "none heard" with 100 LLDP frames on the wire. Fixed, and rebuilt as a port survey (section 5) |
| Pressing `C` cleans up after itself               | **Was broken** — left a root `tcpdump` running indefinitely. Fixed; verified nothing survives a stop                     |
| `C` lists the VLANs on a trunk                    | **Works** — four injected VLANs enumerated live, each with its own addressing                                            |

---

## 1. 802.1Q tagging works on both chipsets

### What the driver advertises

```
en9: options=404<VLAN_MTU,CHANNEL_IO>
en7: options=6464<VLAN_MTU,TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
```

Both set `IFCAP_VLAN_MTU` (0x4); **neither** sets `IFCAP_VLAN_HWTAGGING` (0x8). So macOS inserts and
strips the tag in software via `vlan(4)` rather than offloading it to the chipset. That costs a
little CPU and nothing else — it does not make the dongles unsuitable for VLAN work.

### The test

`vlan0` on `en9` and `vlan1` on `en7`, both VLAN 100, addressed `10.99.100.1/24` and `.2/24`.
Created with `ifconfig`, deliberately **not** `networksetup -createVLAN`, so nothing is written to
System Configuration and a reboot cannot leave residue.

### The evidence — a complete tagged round trip

Captured on the **sender** `en9`:

```
6c:6e:07:01:ff:de > ff:ff:ff:ff:ff:ff, ethertype 802.1Q (0x8100), length 46:
    vlan 100, p 0, ethertype ARP, Request who-has 10.99.100.2 tell 10.99.100.1
00:e0:4c:be:53:2c > 6c:6e:07:01:ff:de, ethertype 802.1Q (0x8100), length 60:
    vlan 100, p 0, ethertype ARP, Reply 10.99.100.2 is-at 00:e0:4c:be:53:2c
```

and the same frames arriving on the **receiver** `en7`. The ARP table resolved:

```
? (10.99.100.2) at 0:e0:4c:be:53:2c on vlan0 ifscope [vlan]
```

A simultaneous capture of **untagged** traffic on `en7` was completely empty, so nothing stripped the
tag along the way.

That is a full request-and-reply exchange in which every frame carried an 802.1Q header: the ASIX
transmitted it, the Zyxel forwarded it, the Realtek received it, its stack processed it, and the
reply came back the same way. Both chipsets pass tagged traffic.

### The control that makes the above mean something

`vlan1` was destroyed and recreated on VLAN **200** while `vlan0` stayed on 100. ARP then never
resolved — three requests, no reply:

```
6c:6e:07:01:ff:de > ff:ff:ff:ff:ff:ff, ... vlan 100, ... Request who-has 10.99.100.2 tell 10.99.100.1
6c:6e:07:01:ff:de > ff:ff:ff:ff:ff:ff, ... vlan 100, ... Request who-has 10.99.100.2 tell 10.99.100.1
6c:6e:07:01:ff:de > ff:ff:ff:ff:ff:ff, ... vlan 100, ... Request who-has 10.99.100.2 tell 10.99.100.1
```

The only thing that changed between the two runs is the VLAN ID, and the outcome flipped. The tag is
genuinely being honoured, not ignored.

That capture also showed `vlan 100` and `vlan 200` frames arriving on `en7` side by side — the
unmanaged switch forwards both without inspecting them, and the endpoint does the filtering.

### Why `ping` still failed, and why that is not a VLAN failure

`ping` reported 100% loss even with matching VLAN IDs. That is an artefact of the test topology, not
of the dongles: both endpoints are on the **same host** in the **same subnet**, so the ICMP echo
reply's destination `10.99.100.1` is a local address and the kernel routes it internally instead of
putting it on the wire. ARP is answered at the link layer on the interface the request arrived on,
which is why it completes while ICMP does not.

**The ARP round trip is the proof; the ping is not.** Testing this properly needs a second machine.

---

## 2. The unmanaged switch floods LLDP's reserved multicast

`01:80:c2:00:00:0e` is in the range a conforming 802.1D bridge must **not** forward — it means
"nearest bridge", and a real switch consumes it. This Zyxel forwarded it: frames sent from `en9`
arrived at `en7`. Broadcast `ff:ff:ff:ff:ff:ff` was forwarded too.

Useful to know when interpreting a "none heard" result in the field: on an unmanaged switch, silence
means nothing is generating LLDP, not that it is being filtered.

---

## 3. Real `tcpdump` LLDP output differs from the documented format

The fixture `parseDiscovery` was written against is not what tcpdump 4.99.1 (Apple 158) prints.
Real output, captured on `en7`:

```
14:37:28.159907 LLDP, length 81
	Chassis ID TLV (1), length 7
	  Subtype MAC address (4): 6c:6e:07:01:ff:de
	Port ID TLV (2), length 20
	  Subtype Interface Name (5): GigabitEthernet0/24
	Time to Live TLV (3), length 2: TTL 120s
	System Name TLV (5), length 20: zyxel-unmanaged-test
	Management Address TLV (8), length 12
	  Management Address length 5, AFI IPv4 (1): 10.0.0.5
	  Interface Index Interface Numbering (2): 1
	Organization specific TLV (127), length 6: OUI Ethernet bridged (0x0080c2)
	  Port VLAN Id Subtype (1)
	    port vlan id (PVID): 100
	End TLV (0), length 0
```

Two differences from the hand-written fixture:

- every header carries the word **`TLV`** (`Chassis ID TLV (1)`, not `Chassis ID (1)`);
- the port VLAN is **nested two levels** under `Organization specific TLV (127)` as
  `port vlan id (PVID): 100`, rather than printed inline as `Port VLAN ID (127), length 6: PVID 100`.

**The parser survives both.** `System Name[^:]*:` still reaches past ` TLV (5), length 20`, and
`Port VLAN ID[^:]*:\s*(?:PVID\s*)?(\d+)` works because a negated character class also matches
newlines, so `[^:]*` spans from `Port VLAN Id Subtype (1)` down to `port vlan id (PVID)` before the
first colon. That is luck as much as design, which is why this capture is now a committed fixture in
`test/discover.test.ts` — the format is no longer something we are guessing at.

---

## 4. Bug (now fixed): `C` never reported a neighbour, and leaked a root `tcpdump`

**Fixed on 2026-08-04**, and the feature was rebuilt around what section 1 proved — see section 5.
The diagnosis is kept because the failure mode is subtle and worth not rediscovering.

Two observations, both reproducible at the time:

**It reports nothing even when there is something.** A beacon transmitted **100 LLDP frames** out
`en9` (confirmed complete: `sent 100 frames`, no errors) spanning the app's entire 35-second capture
window on `en7`. The app reported `No LLDP/CDP heard in 35 s`. A plain `tcpdump` with the app's exact
filter captures those same frames reliably, and the parser reads them correctly — so neither the
filter nor the parser is at fault.

**It leaves a privileged process behind.** The `tcpdump` started by the first `C` press at 14:16:53
was still running 20 minutes later, despite the wrapper's `sleep 35; kill $p`:

```
45406 root 19:59 tcpdump -l -i en7 -nn -v -s0 ether proto 0x88cc or ether dst 01:00:0c:cc:cc:cc
```

Every press leaks another one. They hold the interface in promiscuous mode and only `kill -9` stops
them.

### The mechanism, confirmed

`discover.ts:87` — the file has since been renamed `survey.ts` — stopped the capture with:

```sh
tcpdump … & p=$!; sleep 35; kill $p 2>/dev/null; wait $p 2>/dev/null; true
```

That exact wrapper was run twice with LLDP frames on the wire, once as written and once with the
signal changed to `kill -9`, with a watchdog to catch a hang. The capture window was shortened from
35 s to 10 s:

| Variant                              | Wrapper returned                           | `tcpdump` alive afterwards |
| ------------------------------------ | ------------------------------------------ | -------------------------- |
| `kill` (SIGTERM) — what the app does | **never** (the watchdog killed it at 25 s) | **yes**                    |
| `kill -9` (SIGKILL)                  | after exactly 10 s, on its own             | no                         |

A plain foreground `tcpdump` with the same filter captured the frames throughout, so they were
demonstrably on the wire for both variants.

So the chain is:

1. SIGTERM does not stop `tcpdump` — a BSD BPF read blocks until the buffer fills or a packet
   arrives, so the signal flag is never examined.
2. `wait $p` therefore never returns, and the leaked `tcpdump` keeps running.
3. `do shell script` yields its output only when the command completes, so `osascript` prints
   nothing.
4. `run()`'s `execFile` timeout fires at `35 s + 10 s` and returns empty stdout. This matches the
   observed ~45 s delay between pressing `C` and the result appearing, on both presses.
5. `parseDiscovery('')` returns `[]`, which `discover()` reports as `none-seen`.

Changing that one `kill` to `kill -9` fixes both symptoms at once: the wrapper returns on time with
its output intact, and nothing is left behind. `tcpdump` is already writing line-buffered (`-l`), so
SIGKILL loses nothing from the stdio buffer.

---

## 5. What replaced it: a live port survey

Section 1 showed that VLAN tags are readable off the wire from any switch, while section 4 showed
that LLDP — the only thing the feature used to look for — depends entirely on the switch choosing to
advertise. So `C` no longer listens for LLDP; it surveys the port, and LLDP is a bonus on top.

- **One filter, `ether broadcast or ether multicast`.** Every signal worth having is broadcast or
  multicast: flooded tagged frames, ARP, LLDP (`01:80:c2:00:00:0e`), CDP (`01:00:0c:cc:cc:cc`) and
  STP. It also excludes unicast, which is the bulk of an uplink's traffic and says nothing here.
- **Runs until stopped**, rather than for a fixed 35 s, with results pushed as they accumulate.
- **`kill -9`** everywhere a capture is stopped, including the permission probe.

`do shell script` returns output only once the command exits, so a run-until-stopped capture cannot
read `osascript`'s stdout at all — that is the same property behind the bug above. Instead the
elevated shell appends to a temp file and waits for a sentinel file to appear; the app tails the
temp file and creates the sentinel to stop, which needs no second password prompt. Where capture
privileges already exist (ChmodBPF), no shell is involved at all: `tcpdump` is spawned directly with
its output redirected into the same file, and stopped with `SIGKILL`.

### Verified live

Both dongles on the unmanaged switch, with a synthetic trunk injected from `en9` — tagged broadcast
ARP on VLANs 1, 10, 20 and 99, each in its own subnet — and surveyed from `en7`:

```
Trunk        4 VLANs seen
VLAN 1       27 frames · 192.168.1.x
VLAN 10      27 frames · 10.10.0.x
VLAN 20      27 frames · 10.20.0.x
VLAN 99      27 frames · 172.16.99.x
Surveying 0:53 · 136 frames · C stops
```

Confirmed in that run: VLANs appear and their counts climb while the capture is live; `C` stops it
and the results stay on screen; **no `tcpdump` survives the stop and no temp file is left behind**.

Two details settled along the way that had been assumptions:

- `tcpdump -e` does print `vlan N` — worth checking, because every capture taken earlier that day
  used `-e` and none of them demonstrated the flag was load-bearing.
- The elapsed clock counts the **capture**, not the keypress. It first read 2:46 for a 25-second
  capture because it had been counting since `C` was pressed, including four minutes of waiting at
  a password prompt. It now starts when `tcpdump` writes its first byte.

### Still not verified

- **Quitting the app mid-survey.** `before-quit` writes the sentinel, and the script's 10-minute cap
  is the backstop, but the path has not been exercised.
- **A real managed switch.** The trunk here was synthetic, and PVST+ — which would enumerate every
  VLAN allowed on a Cisco trunk — has never been seen by this parser.

Not fixed here: this pass was scoped to findings only.

---

## What is not established

- **Full-size tagged frames.** `ping -D -s 1472` (1522 bytes on the wire with the tag) produced no
  traffic on the receiver, but only the receiver was being sniffed, so it is unknown whether the
  sender never transmitted or the switch dropped them. Inconclusive, not a failure.
- **VLAN behaviour on Windows and Linux.** Different code paths, no hardware here.
- **Whether a real managed switch's LLDP parses correctly.** The frame used here was synthetic;
  it is well-formed 802.1AB, but a Cisco or HP switch emits more TLVs and may format them differently.
- **CDP.** Nothing was generated for it; the CDP fixture remains hand-written.

## Re-running this

The scripts live in the session scratchpad, not in the repo — they are one-shot diagnostics, not
something to maintain. The pieces worth knowing if you rebuild them:

- Injecting a frame needs `BIOCSETIF = 0x8020426c` and `BIOCSHDRCMPLT = 0x80044275` on arm64 macOS.
  Do not derive these by hand; a three-line C program that includes `<net/bpf.h>` prints them.
- Sniff **both** ends, and capture all of `vlan` rather than `vlan and icmp` — filtering on ICMP hides
  an ARP failure, which is where the interesting behaviour actually is.
- Stop `tcpdump` with `kill -9`. SIGTERM does not work when nothing matches the filter, and a
  `wait` on it will hang your script — which is the same defect described in section 4.
