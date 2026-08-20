# Third-party notices

The browser-side Intel HEX, STK500v1 and STK500v2 modules in this project are an original implementation. No third-party JavaScript uploader is bundled.

Protocol behavior and board profiles were checked against:

- Arduino AVR Boards `boards.txt` and the Arduino Uno Optiboot sources.
- Arduino Mega 2560 `stk500boot.c` implementation of STK500v2.
- AVRDUDE documentation/source behavior. AVRDUDE is GPL-2.0; no AVRDUDE source code is copied or distributed in the browser modules.
- The Web Serial `SerialPort.setSignals()` specification/MDN documentation.

The compiled application HEX files incorporate code from:

- Arduino AVR Core 1.8.8 — LGPL-2.1.
- Arduino Servo 1.3.0 — LGPL-2.1.
- DHT sensor library by Adafruit 1.4.7 — MIT.
- Adafruit Unified Sensor 1.1.15 — Apache-2.0.

Refer to the upstream projects for their complete license texts and corresponding source code. The supplied HEX images contain application flash only; bootloaders, fuses, EEPROM and lock bits are not included or modified.
