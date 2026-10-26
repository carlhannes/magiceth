// Real packets from a factory-default USW-Flex-Mini, captured 2026-10-26 on the dongle (en9,
// AX88179A) with nothing else on the link, per CONFIGURE-TEST.md step 1. Firmware 2.1.6.762.
// UDP payloads only; the hex is exactly what tcpdump saw. Keep these as the ground truth and
// extend them with captures of the OFFER/REQUEST/ACK exchange and an inform body when those exist.

export const FLEX_MINI_MAC = 'ac:8b:a9:af:9a:6f'

/**
 * The DISCOVER the Flex Mini repeats every 20 s while unleased. Broadcast flag clear, no client
 * id, vendor class `ubnt`, hostname `USW-Flex-Mini`, parameter list 1 3 28 6 12 15 43.
 */
export const FLEX_MINI_DISCOVER =
  '01010600c36d91aa0000000000000000000000000000000000000000ac8ba9af9a6f' +
  '00'.repeat(202) +
  '63825363350101390205dc0c0d5553572d466c65782d4d696e69370701031c060c0f2b3c0475626e74ff' +
  '00'.repeat(30)

/**
 * Its discovery announcement on UDP 10001, sent every 10 s from the 192.168.1.20 fallback address
 * while unleased. Protocol version 2, command 6. TLV 0x17 = 01 marks it factory default.
 */
export const FLEX_MINI_DISCOVERY =
  '020600ac02000aac8ba9af9a6fc0a80114010006ac8ba9af9a6f0a0004000000320b000d5553572d466c6578' +
  '2d4d696e690c000655534d494e4914000d5553572d466c65782d4d696e6903002255532e6d3438372e626f6f' +
  '745f322e312e362b3736322e3235303830372e31373335160009322e312e362e37363215000655534d494e49' +
  '17000101180001002c000103190001011a000101130006ac8ba9af9a6f120004000000041b0005312e372e33'

/** The Mac's own DHCP client on the same link: no vendor class, client id, a 90-day lease wish. */
export const MAC_HOST_DISCOVER =
  '01010600a96ac97000000000000000000000000000000000000000006c6e0701ffde' +
  '00'.repeat(202) +
  '63825363350101370d017903060f6c7277a2fc5f2c2e390205dc3d07016c6e0701ffde33040076a7000c0c' +
  '68616e6e65732d6d62706d34ff' +
  '00'.repeat(8)
