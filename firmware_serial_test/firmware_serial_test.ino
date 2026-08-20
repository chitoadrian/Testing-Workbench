/* Diagnóstico mínimo USB Serial para Arduino Uno/Mega. */
String serialBuffer="";

void setup(){
  Serial.begin(115200);
  serialBuffer.reserve(64);
  delay(500);
  Serial.println(F("{\"ok\":true,\"event\":\"ready\",\"device\":\"arduino-test\",\"baud\":115200}"));
}

void loop(){
  while(Serial.available()>0){
    char c=(char)Serial.read();
    if(c=='\n'){
      serialBuffer.trim();
      if(serialBuffer=="PING"){
        Serial.println(F("{\"ok\":true,\"command\":\"PING\",\"event\":\"pong\"}"));
      }else if(serialBuffer.length()>0){
        Serial.print(F("{\"ok\":false,\"command\":\""));
        Serial.print(serialBuffer);
        Serial.println(F("\",\"error\":\"UNKNOWN_COMMAND\"}"));
      }
      serialBuffer="";
    }else if(c!='\r' && serialBuffer.length()<63){
      serialBuffer+=c;
    }
  }
}
