/* HW Testing Workbench — firmware base Arduino Uno/Mega y ESP32.
   Protocolo ASCII, un comando por línea. Respuestas JSON, una por línea.
   Para DHT: instalar "DHT sensor library" de Adafruit. */

#include <Arduino.h>
#ifdef ESP32
  #include <ESP32Servo.h>           // Instalar "ESP32Servo" en placas ESP32.
#else
  #include <Servo.h>
#endif
#include <DHT.h>

#define FW_NAME "HW-WORKBENCH"
#define FW_VERSION "1.0.0"

#ifdef ESP32
  const uint8_t LED_PIN=2, BUZZER_PIN=25, RELAY_PIN=26, SERVO_PIN=13;
  const uint8_t TRIG_PIN=5, ECHO_PIN=18, LDR_PIN=34, MOTOR_A=27, MOTOR_B=14, MOTOR_PWM=33, DHT_PIN=4;
#else
  const uint8_t LED_PIN=5, BUZZER_PIN=4, RELAY_PIN=7, SERVO_PIN=9;
  const uint8_t TRIG_PIN=10, ECHO_PIN=11, LDR_PIN=A0, MOTOR_A=12, MOTOR_B=13, MOTOR_PWM=6, DHT_PIN=2;
#endif

#define DHT_TYPE DHT22              // Cambiar por DHT11 si corresponde.
DHT dht(DHT_PIN, DHT_TYPE);
Servo servoMotor;
String inputLine;
bool blinkActive=false, relayPulseActive=false;
uint8_t blinkTransitions=0;
unsigned long blinkChangedAt=0, relayOffAt=0;

void replyOK(const String &command, const String &extra="") {
  Serial.print(F("{\"ok\":true,\"command\":\"")); Serial.print(command); Serial.print('"');
  if (extra.length()) { Serial.print(','); Serial.print(extra); }
  Serial.println('}');
}

void replyError(const String &message) {
  Serial.print(F("{\"ok\":false,\"error\":\"")); Serial.print(message); Serial.println(F("\"}"));
}

int tokenInt(const String &command, int tokenIndex) {
  int start=0;
  for (int i=0; i<tokenIndex; i++) { start=command.indexOf(':', start)+1; if (start==0) return 0; }
  int end=command.indexOf(':', start); if (end<0) end=command.length();
  return command.substring(start,end).toInt();
}

long readDistanceCm() {
  digitalWrite(TRIG_PIN,LOW); delayMicroseconds(2); digitalWrite(TRIG_PIN,HIGH); delayMicroseconds(10); digitalWrite(TRIG_PIN,LOW);
  unsigned long duration=pulseIn(ECHO_PIN,HIGH,30000UL); return duration ? long(duration*0.0343/2.0) : -1;
}

void setMotor(bool forward, int percent) {
  percent=constrain(percent,0,100); digitalWrite(MOTOR_A,forward); digitalWrite(MOTOR_B,!forward);
  analogWrite(MOTOR_PWM,map(percent,0,100,0,255));
}

void executeCommand(String cmd) {
  cmd.trim(); cmd.toUpperCase();
  // PING no depende de sensores, actuadores ni de ninguna inicialización externa.
  if (cmd=="PING") {
    Serial.println(F("{\"ok\":true,\"command\":\"PING\",\"event\":\"pong\"}"));
    return;
  }
  if (cmd=="GET:INFO") {
    Serial.println(F("{\"ok\":true,\"command\":\"GET:INFO\",\"device\":\"arduino\",\"firmware\":\"" FW_NAME "\",\"version\":\"" FW_VERSION "\"}"));
    return;
  }
  if (cmd=="SET:LED:1") { blinkActive=false; digitalWrite(LED_PIN,HIGH); replyOK(cmd); }
  else if (cmd=="SET:LED:0") { blinkActive=false; digitalWrite(LED_PIN,LOW); replyOK(cmd); }
  else if (cmd.startsWith("SET:LED:PWM:")) { int value=constrain(tokenInt(cmd,3),0,255); analogWrite(LED_PIN,value); replyOK("SET:LED:PWM", "\"value\":"+String(value)); }
  else if (cmd.startsWith("BLINK:LED:")) { int count=constrain(tokenInt(cmd,2),1,50); blinkTransitions=count*2; blinkActive=true; blinkChangedAt=millis()-80; replyOK("BLINK:LED", "\"cycles\":"+String(count)); }
  else if (cmd=="BUZZER:STOP") { noTone(BUZZER_PIN); replyOK(cmd); }
  else if (cmd.startsWith("BUZZER:")) { int hz=constrain(tokenInt(cmd,1),100,8000), duration=constrain(tokenInt(cmd,2),20,5000); tone(BUZZER_PIN,hz,duration); replyOK("BUZZER", "\"hz\":"+String(hz)); }
  else if (cmd=="SET:RELAY:1") { relayPulseActive=false; digitalWrite(RELAY_PIN,HIGH); replyOK(cmd); }
  else if (cmd=="SET:RELAY:0") { relayPulseActive=false; digitalWrite(RELAY_PIN,LOW); replyOK(cmd); }
  else if (cmd.startsWith("PULSE:RELAY:")) { int ms=constrain(tokenInt(cmd,2),20,5000); digitalWrite(RELAY_PIN,HIGH);relayPulseActive=true;relayOffAt=millis()+(unsigned long)ms;replyOK("PULSE:RELAY"); }
  else if (cmd=="GET:TEMP") { float h=dht.readHumidity(),t=dht.readTemperature(); if(isnan(h)||isnan(t)) replyError("DHT read failed"); else replyOK(cmd,"\"temp\":"+String(t,1)+",\"humidity\":"+String(h,1)); }
  else if (cmd=="GET:DISTANCE") { long cm=readDistanceCm(); if(cm<0) replyError("Ultrasonic timeout"); else replyOK(cmd,"\"distance\":"+String(cm)); }
  else if (cmd=="GET:LDR") { replyOK(cmd,"\"ldr\":"+String(analogRead(LDR_PIN))); }
  else if (cmd.startsWith("SERVO:")) { int angle=constrain(tokenInt(cmd,1),0,180); servoMotor.write(angle); replyOK("SERVO","\"angle\":"+String(angle)); }
  else if (cmd.startsWith("MOTOR:FWD:")) { int speed=constrain(tokenInt(cmd,2),0,100);setMotor(true,speed);replyOK("MOTOR:FWD","\"speed\":"+String(speed)); }
  else if (cmd.startsWith("MOTOR:REV:")) { int speed=constrain(tokenInt(cmd,2),0,100);setMotor(false,speed);replyOK("MOTOR:REV","\"speed\":"+String(speed)); }
  else if (cmd=="MOTOR:STOP") { analogWrite(MOTOR_PWM,0);digitalWrite(MOTOR_A,LOW);digitalWrite(MOTOR_B,LOW);replyOK(cmd); }
  else replyError("Unknown command: "+cmd);
}

void setup() {
  Serial.begin(115200); inputLine.reserve(96);
  pinMode(LED_PIN,OUTPUT); pinMode(BUZZER_PIN,OUTPUT); pinMode(RELAY_PIN,OUTPUT);
  pinMode(TRIG_PIN,OUTPUT); pinMode(ECHO_PIN,INPUT); pinMode(MOTOR_A,OUTPUT); pinMode(MOTOR_B,OUTPUT); pinMode(MOTOR_PWM,OUTPUT);
  servoMotor.attach(SERVO_PIN); servoMotor.write(90); dht.begin();
  delay(500);
  Serial.println(F("{\"ok\":true,\"event\":\"ready\",\"device\":\"arduino\",\"baud\":115200}"));
}

void loop() {
  unsigned long now=millis();
  if(blinkActive && now-blinkChangedAt>=80){blinkChangedAt=now;digitalWrite(LED_PIN,!digitalRead(LED_PIN));if(--blinkTransitions==0){blinkActive=false;digitalWrite(LED_PIN,LOW);}}
  if(relayPulseActive && (long)(now-relayOffAt)>=0){relayPulseActive=false;digitalWrite(RELAY_PIN,LOW);}
  while (Serial.available()) {
    char c=(char)Serial.read();
    if (c=='\n') { inputLine.trim(); if(inputLine.length()) executeCommand(inputLine); inputLine=""; }
    else if (c!='\r' && inputLine.length()<95) inputLine+=c;
  }
}
