import CoreLocation
import CoreWLAN
import Foundation

// magiceth Wi-Fi helper.
//
// This exists for exactly one reason. macOS reveals a scanned network's BSSID and its beacon
// information elements only to a process holding a Location Services grant, and it only ever
// offers that grant to a real bundle — one with a CFBundleIdentifier and an
// NSLocationWhenInUseUsageDescription. A bare command-line binary calling
// requestWhenInUseAuthorization() is a silent no-op: no dialog, no error, status stays
// notDetermined. Hence a tiny .app rather than a plain executable.
//
// It stays deliberately stupid. It emits the raw information elements as hex and decodes none of
// them, because every parser belongs in TypeScript where it can be unit-tested against real
// captured output without a radio. What is left here is only the part that nothing else can do.
//
// Output is one JSON object on stdout. Exit codes: 0 ok, 2 no usable permission, 3 no interface,
// 4 the scan itself failed.

/// How long to wait for the user to answer the permission dialog. Generous on purpose — the dialog
/// can sit unanswered while someone is away from the machine, and giving up early would report a
/// refusal that never happened.
let authWaitSeconds = 180.0

/// `--interface <name>` picks a card; `--out <path>` writes the result to a file instead of stdout.
///
/// `--out` exists because of how TCC assigns responsibility. A binary started from a shell is
/// attributed to the terminal, so its own bundle identity — and therefore its Location grant —
/// is ignored. Launching through LaunchServices (`open`) makes the helper responsible for itself,
/// but `open` discards stdout, so there has to be somewhere else to put the answer.
struct Args {
    var interface: String?
    var out: String?
}

func parseArgs(_ argv: [String]) -> Args {
    var args = Args()
    var i = 0
    while i < argv.count {
        switch argv[i] {
        case "--interface" where i + 1 < argv.count:
            args.interface = argv[i + 1]
            i += 2
        case "--out" where i + 1 < argv.count:
            args.out = argv[i + 1]
            i += 2
        default:
            i += 1
        }
    }
    return args
}

let args = parseArgs(Array(CommandLine.arguments.dropFirst()))

func emit(_ object: [String: Any]) {
    let data =
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
        ?? Data("{\"status\":\"error\",\"message\":\"could not serialize result\"}".utf8)
    if let path = args.out {
        try? (data + Data("\n".utf8)).write(to: URL(fileURLWithPath: path))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func bail(_ status: String, _ message: String, _ code: Int32) -> Never {
    emit(["status": status, "message": message, "networks": []])
    exit(code)
}

/// Asks for authorization and blocks until the user answers, the deadline passes, or the status was
/// already decided. Polling the run loop rather than stopping it from the delegate keeps the
/// timeout in one place and needs no shared mutable state.
final class AuthWaiter: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
    }

    var status: CLAuthorizationStatus { manager.authorizationStatus }

    func waitForDecision(timeout: TimeInterval) {
        guard manager.authorizationStatus == .notDetermined else { return }
        manager.requestWhenInUseAuthorization()
        let deadline = Date().addingTimeInterval(timeout)
        while manager.authorizationStatus == .notDetermined && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.25))
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {}
}

// CLAuthorizationStatus is switched on its raw value because .authorized and .authorizedAlways
// share one, and a Swift switch cannot list both.
func authName(_ status: CLAuthorizationStatus) -> String {
    switch status.rawValue {
    case 0: return "notDetermined"
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "authorizedAlways"
    case 4: return "authorizedWhenInUse"
    default: return "unknown"
    }
}

let waiter = AuthWaiter()
waiter.waitForDecision(timeout: authWaitSeconds)
let auth = authName(waiter.status)

let client = CWWiFiClient.shared()
let interfaceNames = client.interfaceNames() ?? []

// A named interface wins over the default one, so the Linux/Windows card-selection story later has
// somewhere to land without reshaping the contract.
let interface = args.interface.flatMap { client.interface(withName: $0) } ?? client.interface()

guard let itf = interface else {
    bail("no-interface", "This machine has no Wi-Fi interface.", 3)
}

let networks: Set<CWNetwork>
do {
    networks = try itf.scanForNetworks(withSSID: nil, includeHidden: true)
} catch {
    bail("error", "Scan failed: \(error.localizedDescription)", 4)
}

var out: [[String: Any]] = []
for n in networks {
    var entry: [String: Any] = [
        "ssid": n.ssid ?? "",
        "rssi": n.rssiValue,
        "noise": n.noiseMeasurement,
        "beaconInterval": n.beaconInterval,
        "ibss": n.ibss
    ]
    if let bssid = n.bssid { entry["bssid"] = bssid }
    if let country = n.countryCode { entry["countryCode"] = country }
    if let channel = n.wlanChannel {
        entry["channel"] = channel.channelNumber
        entry["band"] = channel.channelBand.rawValue
        entry["width"] = channel.channelWidth.rawValue
    }
    if let ie = n.informationElementData {
        entry["ie"] = ie.map { String(format: "%02x", $0) }.joined()
    }
    out.append(entry)
}

// A scan that produced no BSSIDs is not a working scan, whatever the authorization status claims —
// say so in the status rather than handing back a list the caller cannot group.
let usable = out.contains { $0["bssid"] != nil }
emit([
    "status": usable ? "ok" : "needs-permission",
    "auth": auth,
    "interface": itf.interfaceName ?? "",
    "interfaces": interfaceNames,
    "networks": out
])
exit(usable ? 0 : 2)
