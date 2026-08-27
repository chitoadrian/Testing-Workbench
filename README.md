# HW Testing Workbench

Aplicación publicada en **https://chitoadrian.github.io/Testing-Workbench/** para controlar, recuperar, programar y diagnosticar Arduino mediante Web Serial API. No requiere Arduino IDE para la instalación normal del firmware incluido.

## Compatibilidad y diagnóstico entre computadoras

La publicación usa una única constante `window.__HW_BUILD_VERSION__` en `index.html` para versionar los recursos propios y mostrar el build activo en Diagnóstico. El build actual es `2026.08.27.1`; el query string obliga a GitHub Pages y al navegador a solicitar los recursos actualizados.

La interfaz general funciona en navegadores modernos aunque Web Serial no exista. El acceso físico al Arduino requiere Chrome, Edge o Chromium de escritorio con Web Serial habilitado, contexto HTTPS/localhost, permiso USB y ausencia de políticas administrativas que lo bloqueen. La aplicación detecta estas restricciones y no intenta evadirlas.

Pruebas sin hardware: `node firmware-flasher.test.mjs`, `node serial-lifecycle.test.mjs` y `node ui-smoke.test.mjs`.

## Primera conexión sin Arduino IDE

1. Conecte Arduino Uno o Mega 2560 por USB.
2. Abra **https://chitoadrian.github.io/Testing-Workbench/** en Chrome/Edge.
3. Pulse **Buscar dispositivo** y seleccione el puerto USB Serial.
4. En **Firmware del Arduino**, elija manualmente Uno o Mega 2560.
5. Pulse **Instalar firmware en Arduino**.
6. No desconecte el USB mientras se escriben y verifican las páginas.
7. Espere **Carga completada**, el reinicio y la reconexión automática.
8. Compruebe **Firmware HW-WORKBENCH v1.0.0** y **Arduino operativo ✓**.

La demostración no requiere Arduino IDE ni Arduino CLI; solo acceso al sitio HTTPS publicado. Los HEX están incluidos en `firmware/uno` y `firmware/mega`. La placa debe conservar su bootloader Serial estándar; una placa sin bootloader requiere un programador ISP y no puede recuperarse desde Web Serial.

### Cargador web AVR

- Arduino Uno: Optiboot/STK500v1, 115200 baud, páginas de 128 bytes, firma ATmega328P `1E 95 0F`.
- Arduino Mega 2560: Wiring/STK500v2, 115200 baud, páginas de 256 bytes, firma ATmega2560 `1E 98 01`.
- El reset intenta alternar DTR mediante `SerialPort.setSignals()`; si el adaptador no lo admite, se utiliza el reset automático producido al abrir el puerto.
- La carga escribe solamente flash de aplicación y vuelve a leer cada página para verificarla. No escribe fuses, lock bits, EEPROM ni bootloader.
- La sugerencia basada en VID/PID nunca reemplaza la elección manual, especialmente con clones CH340/CH341.

## INICIO RÁPIDO — GitHub Pages, sin Arduino IDE

1. Abra **https://chitoadrian.github.io/Testing-Workbench/** en Chrome o Edge.
2. Conecte Arduino Uno/Mega mediante un cable USB de datos.
3. Pulse **Buscar dispositivo** y autorice el puerto.
4. Cuando el Workbench obtenga control real del puerto, use **Instalar firmware en Arduino**. Los HEX para Uno/Mega ya están incluidos en el sitio.
5. Espere la carga, verificación, reinicio y PING/PONG automáticos.

El servidor local se conserva únicamente para desarrollo. La demostración y la instalación normal usan GitHub Pages y no requieren Arduino IDE.

Web Serial requiere un contexto seguro (`localhost` o HTTPS) y no funciona al abrir `index.html` directamente con `file://`. Firefox y Safari no ofrecen soporte completo. Cierra el Monitor Serial de Arduino IDE antes de conectar, pues un puerto solo puede ser usado por una aplicación a la vez.

## Uso en otra computadora

1. Copiar la carpeta completa del proyecto.
2. Tener Chrome o Microsoft Edge actualizado.
3. Abrir CMD dentro de la carpeta `hardware-testing-workbench`.
4. Ejecutar `python -m http.server 8080` o `py -m http.server 8080`.
5. Abrir `http://localhost:8080` directamente en Chrome o Edge.
6. Conectar Arduino mediante un cable USB de datos.
7. Comprobar en **Administrador de dispositivos → Puertos (COM y LPT)** que Windows reconoce la placa.
8. Cerrar Serial Monitor y Serial Plotter de Arduino IDE.
9. Pulsar **Buscar dispositivo**.
10. Seleccionar Arduino en el selector del navegador.

No abrir `index.html` directamente mediante `file://` ni usar una vista previa integrada del IDE para acceder al USB.

En computadoras administradas por una institución, las políticas del navegador pueden bloquear Web Serial incluso cuando Chrome/Edge lo soportan. Si la placa no aparece, revise también el cable (algunos sólo cargan), el driver, otro puerto USB y que ninguna aplicación tenga ocupado el COM. La aplicación puede orientar el diagnóstico, pero no puede instalar drivers ni cambiar políticas de Windows o del navegador.

Arduino Uno/Mega suele reiniciarse al abrir el puerto. La interfaz espera ese reinicio, envía un `PING` real y sólo habilita los controles físicos tras recibir la respuesta del firmware. Que no haya dispositivos previamente autorizados no significa que Arduino esté desconectado: pulse **Buscar dispositivo** para abrir el selector.

## Recuperación de la sesión Serial

- **Buscar dispositivo** siempre abre una selección nueva del navegador.
- **Conectar dispositivo** reutiliza un puerto autorizado sólo cuando existe; si no, abre el selector.
- Ante `NetworkError`, la página realiza hasta tres recuperaciones automáticas con esperas de 400, 900 y 1500 ms antes de declarar el puerto ocupado externamente.
- **Recuperar puerto** aparece después de un fallo permanente, ejecuta una limpieza profunda, conserva el permiso y vuelve a localizar el último Arduino autorizado sin abrir el selector.
- **Reiniciar sesión Serial** cancela operaciones, libera reader/writer y sus locks, espera streams de cierre, intenta cerrar el puerto aunque el estado interno esté desincronizado y vuelve a consultar permisos sin olvidarlos.
- Web Locks y BroadcastChannel coordinan pestañas del mismo sitio. **Tomar control** solicita a la otra pestaña que libere voluntariamente el puerto; nunca rompe un lock por fuerza.
- **Olvidar / cambiar dispositivo** usa la API `forget()` únicamente cuando el navegador la ofrece. Si no está disponible, cambie el permiso desde los ajustes del sitio de Chrome/Edge.

La aplicación distingue un lock interno recuperable, otra pestaña del Workbench y un bloqueo externo probable. Si otra aplicación, Windows, Chrome o una política administrativa mantiene el COM, Web Serial no puede liberarlo por fuerza. Cierre la otra aplicación o pida al administrador que revise la política.

Si un puerto autorizado dejó de existir después de desenchufar el USB, use **Buscar dispositivo**. Un permiso guardado no significa que el COM esté presente, abierto ni que el firmware responda.

Si Windows no presenta la placa como puerto COM, Web Serial no puede utilizarla. Revise **Administrador de dispositivos → Puertos (COM y LPT)**, pruebe otro cable USB de datos y otro puerto, e instale el driver correspondiente. Los clones pueden requerir un driver CH340/CH341. La página no puede reparar drivers, hardware ni políticas administrativas.

## Paso A — Comprobar comunicación básica

1. Abrir Arduino IDE.
2. Seleccionar Arduino Uno/Mega.
3. Seleccionar el COM correcto.
4. Abrir y cargar `firmware_serial_test/firmware_serial_test.ino`.
5. Esperar **Done uploading**.
6. Cerrar Serial Monitor y Serial Plotter.
7. Abrir Testing Workbench.
8. Seleccionar el COM.
9. Conectar.
10. Esperar PING/PONG.

Resultado esperado:

```text
Puerto abierto ✓
Firmware responde ✓
Arduino operativo ✓
```

Si funciona con el firmware mínimo, la conexión USB Serial, el puerto, Web Serial y el parser básico están funcionando. El problema restante estaría dentro del firmware completo o sus dependencias.

## Paso B — Probar firmware completo

Sólo después de validar el Paso A, cargar `firmware.ino`. El firmware completo conserva exactamente el intercambio `PING` → JSON con `event: "pong"`, independientemente de que existan sensores conectados.

Para compilar el firmware completo se necesita **DHT sensor library by Adafruit** y, si Arduino IDE lo solicita, **Adafruit Unified Sensor**. Arduino Uno/Mega usan la librería `Servo` incluida con el core AVR. ESP32 requiere además `ESP32Servo`. La ausencia física del DHT no impide responder PING.

## Protocolo

Cada orden es texto ASCII terminado en salto de línea. El firmware responde con una línea JSON. Comandos: `PING`, `SET:LED:1`, `SET:LED:0`, `SET:LED:PWM:128`, `BLINK:LED:10`, `BUZZER:1000:500`, `SET:RELAY:1`, `SET:RELAY:0`, `PULSE:RELAY:500`, `GET:TEMP`, `GET:DISTANCE`, `GET:LDR`, `SERVO:90`, `MOTOR:FWD:50`, `MOTOR:REV:50`, `MOTOR:STOP`.

## Notas de hardware

- Usa un transistor/MOSFET y diodo flyback para motores, relés y cargas inductivas; no los alimentes directamente desde un GPIO.
- Une las tierras de la fuente externa y la placa.
- Los GPIO del ESP32 son de 3,3 V y no toleran 5 V. Adapta el nivel de `ECHO` del HC-SR04.
- Los pines incluidos son una base y deben revisarse según tu shield y cableado antes de energizar el circuito.
- La métrica de salud se guarda localmente en el navegador. Es una estimación operativa, no reemplaza límites del fabricante ni mediciones eléctricas.

## Mapa de pines Arduino Uno/Mega

| Componente | Pin |
|---|---:|
| LED PWM | D5 |
| Buzzer | D4 |
| Relé | D7 |
| DHT | D2 |
| HC-SR04 TRIG / ECHO | D10 / D11 |
| LDR | A0 |
| Servo | D9 |
| Motor PWM / IN1 / IN2 | D6 / D12 / D13 |
| USB Serial | D0 / D1 reservados |

En Arduino Uno, `Servo` utiliza Timer1 y `tone()` utiliza Timer2. Por eso LED y motor utilizan PWM D5/D6 (Timer0), evitando los PWM D9/D10 afectados por Servo y D3/D11 afectados por tone. No alimente motores, relés ni servos directamente desde el Arduino.

## Errores comunes

- **Puerto abierto, firmware sin respuesta:** cargue primero el firmware Serial mínimo, confirme 115200 baud y cierre Serial Monitor.
- **RX permanece en cero:** compruebe que el sketch correcto fue cargado, que el COM corresponde a la placa y que el cable transmite datos.
- **Puerto ocupado:** espere los tres reintentos automáticos y use **Recuperar puerto**. Si persiste, cierre otra pestaña, Arduino IDE Serial Monitor/Plotter y cualquier programa que use el COM. La página no puede forzar la liberación de un proceso externo.
- **Arduino no aparece:** revise Windows, drivers, cable, puerto USB y CH340/CH341 en placas clon.
- **DHT read failed:** revise cableado, tipo DHT11/DHT22 y dependencias; PING debe continuar funcionando.
