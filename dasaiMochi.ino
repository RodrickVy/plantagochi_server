#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>

#define SCREEN_ADDRESS 0x3C  // Change if different

Adafruit_SH1107 display = Adafruit_SH1107(128, 128, &Wire);

int x = 0, y = 50;
int dx = 2, dy = 1;
int radius = 20;

void setup() {
  Wire.begin();
  if (!display.begin(SCREEN_ADDRESS)) {
    Serial.begin(115200);
    Serial.println("Display failed to initialize");
    while (1);
  }
  display.clearDisplay();
}

void loop() {
  display.clearDisplay();

  // Draw filled circle (eye)
  display.fillCircle(x + radius, y + radius, radius, SH110X_WHITE);
  
  // Draw pupil as smaller circle
  display.fillCircle(x + radius + dx*3, y + radius + dy*3, radius/3, SH110X_BLACK);

  display.display();

  // Update position
  x += dx;
  y += dy;

  if (x < 0 || x > 128 - 2*radius) dx = -dx;
  if (y < 0 || y > 128 - 2*radius) dy = -dy;

  delay(20);
}
